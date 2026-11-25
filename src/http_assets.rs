//! Pure-Rust HTTP static asset compression (RFC 1952 Gzip + RFC 1951 DEFLATE),
//! strong SHA-256 ETag / `304 Not Modified` negotiation, and security headers.

use sha2::{Digest, Sha256};
use std::sync::OnceLock;

const GZIP_WINDOW: usize = 32_768;
const GZIP_HASH_SIZE: usize = 32_768;
const GZIP_HASH_MASK: usize = GZIP_HASH_SIZE - 1;
const GZIP_MAX_CHAIN: usize = 16;
const GZIP_MIN_MATCH: usize = 3;
const GZIP_MAX_MATCH: usize = 258;

/// Security headers applied to HTTP responses served by Fleet.
pub const SECURITY_HEADERS: &str =
    "X-Content-Type-Options: nosniff\r\nX-Frame-Options: DENY\r\nReferrer-Policy: no-referrer\r\n";

struct BitWriter {
    out: Vec<u8>,
    acc: u64,
    bits: u8,
}

impl BitWriter {
    fn new(capacity: usize) -> Self {
        Self {
            out: Vec::with_capacity(capacity),
            acc: 0,
            bits: 0,
        }
    }

    #[inline]
    fn write_bits_lsb(&mut self, value: u32, count: u8) {
        self.acc |= u64::from(value) << self.bits;
        self.bits += count;
        while self.bits >= 8 {
            self.out.push((self.acc & 0xff) as u8);
            self.acc >>= 8;
            self.bits -= 8;
        }
    }

    #[inline]
    fn write_huffman_msb(&mut self, code: u16, len: u8) {
        let rev = code.reverse_bits() >> (16 - len);
        self.write_bits_lsb(u32::from(rev), len);
    }

    fn finish_byte_aligned(&mut self) {
        if self.bits > 0 {
            self.out.push((self.acc & 0xff) as u8);
            self.acc = 0;
            self.bits = 0;
        }
    }
}

const CRC32_TABLE: [u32; 256] = {
    let mut table = [0u32; 256];
    let mut i = 0usize;
    while i < 256 {
        let mut c = i as u32;
        let mut k = 0;
        while k < 8 {
            c = if (c & 1) != 0 {
                0xedb8_8320 ^ (c >> 1)
            } else {
                c >> 1
            };
            k += 1;
        }
        table[i] = c;
        i += 1;
    }
    table
};

#[inline]
fn crc32_ieee(data: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for &b in data {
        crc = CRC32_TABLE[((crc ^ u32::from(b)) & 0xff) as usize] ^ (crc >> 8);
    }
    !crc
}

#[inline]
fn write_fixed_lit_len(bw: &mut BitWriter, sym: u16) {
    if sym <= 143 {
        bw.write_huffman_msb(0x30 + sym, 8);
    } else if sym <= 255 {
        bw.write_huffman_msb(0x190 + (sym - 144), 9);
    } else if sym <= 279 {
        bw.write_huffman_msb(sym - 256, 7);
    } else {
        bw.write_huffman_msb(0xc0 + (sym - 280), 8);
    }
}

#[inline]
fn encode_length(len: usize) -> (u16, u8, u32) {
    const BASE_LEN: [u16; 29] = [
        3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115,
        131, 163, 195, 227, 258,
    ];
    const EXTRA_BITS: [u8; 29] = [
        0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
    ];
    for i in (0..29).rev() {
        let base = usize::from(BASE_LEN[i]);
        if len >= base {
            return (257 + i as u16, EXTRA_BITS[i], (len - base) as u32);
        }
    }
    (257, 0, 0)
}

#[inline]
fn encode_distance(dist: usize) -> (u16, u8, u32) {
    const BASE_DIST: [u16; 30] = [
        1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537,
        2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
    ];
    const EXTRA_BITS: [u8; 30] = [
        0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12,
        13, 13,
    ];
    for i in (0..30).rev() {
        let base = usize::from(BASE_DIST[i]);
        if dist >= base {
            return (i as u16, EXTRA_BITS[i], (dist - base) as u32);
        }
    }
    (0, 0, 0)
}

#[inline]
fn hash3(data: &[u8], pos: usize) -> usize {
    let h = (usize::from(data[pos]) << 10)
        ^ (usize::from(data[pos + 1]) << 5)
        ^ usize::from(data[pos + 2]);
    h & GZIP_HASH_MASK
}

/// Compress `input` into a valid RFC 1952 Gzip stream using LZ77 + fixed-Huffman DEFLATE.
pub fn gzip_compress(input: &[u8]) -> Vec<u8> {
    let mut bw = BitWriter::new((input.len() / 2).max(64) + 32);
    // RFC 1952 header: ID1, ID2, CM=8 (deflate), FLG=0, MTIME=0, XFL=2, OS=3 (Unix)
    bw.out
        .extend_from_slice(&[0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x03]);

    // Single final fixed-Huffman DEFLATE block: BFINAL=1, BTYPE=01 (2 bits)
    bw.write_bits_lsb(1, 1);
    bw.write_bits_lsb(1, 2);

    let len = input.len();
    let mut head = vec![u32::MAX; GZIP_HASH_SIZE];
    let mut prev = vec![u32::MAX; GZIP_WINDOW];

    let mut pos = 0usize;
    while pos < len {
        let mut best_len = 0usize;
        let mut best_dist = 0usize;

        if pos + GZIP_MIN_MATCH <= len {
            let h = hash3(input, pos);
            let old_head = head[h];
            prev[pos & (GZIP_WINDOW - 1)] = old_head;
            head[h] = pos as u32;

            let min_pos = pos.saturating_sub(GZIP_WINDOW - 1);
            let mut cur = old_head;
            let mut chain = 0usize;
            while cur != u32::MAX && chain < GZIP_MAX_CHAIN {
                let cand = cur as usize;
                if cand < min_pos {
                    break;
                }
                let dist = pos - cand;
                if dist > 0 && dist <= GZIP_WINDOW {
                    let max_m = (len - pos).min(GZIP_MAX_MATCH);
                    if max_m > best_len
                        && (best_len < GZIP_MIN_MATCH || input[cand + best_len] == input[pos + best_len])
                        && input[cand] == input[pos]
                        && input[cand + 1] == input[pos + 1]
                        && input[cand + 2] == input[pos + 2]
                    {
                        let mut m = 3usize;
                        while m < max_m && input[cand + m] == input[pos + m] {
                            m += 1;
                        }
                        if m > best_len {
                            best_len = m;
                            best_dist = dist;
                            if m == GZIP_MAX_MATCH || m >= 64 {
                                break;
                            }
                        }
                    }
                }
                cur = prev[cand & (GZIP_WINDOW - 1)];
                chain += 1;
            }
        }

        if best_len >= GZIP_MIN_MATCH {
            let (lsym, lextra_bits, lextra_val) = encode_length(best_len);
            write_fixed_lit_len(&mut bw, lsym);
            if lextra_bits > 0 {
                bw.write_bits_lsb(lextra_val, lextra_bits);
            }
            let (dsym, dextra_bits, dextra_val) = encode_distance(best_dist);
            write_fixed_lit_len_dist(&mut bw, dsym, dextra_bits, dextra_val);

            let end = (pos + best_len.min(16)).min(len.saturating_sub(GZIP_MIN_MATCH - 1));
            for p in (pos + 1)..end {
                let h = hash3(input, p);
                prev[p & (GZIP_WINDOW - 1)] = head[h];
                head[h] = p as u32;
            }
            pos += best_len;
        } else {
            write_fixed_lit_len(&mut bw, u16::from(input[pos]));
            pos += 1;
        }
    }

    // End of block (256)
    write_fixed_lit_len(&mut bw, 256);
    bw.finish_byte_aligned();

    let crc = crc32_ieee(input);
    let isize_u32 = input.len() as u32;
    bw.out.extend_from_slice(&crc.to_le_bytes());
    bw.out.extend_from_slice(&isize_u32.to_le_bytes());
    bw.out
}

#[inline]
fn write_fixed_lit_len_dist(bw: &mut BitWriter, dsym: u16, dextra_bits: u8, dextra_val: u32) {
    bw.write_huffman_msb(dsym, 5);
    if dextra_bits > 0 {
        bw.write_bits_lsb(dextra_val, dextra_bits);
    }
}

/// Compute a strong quoted SHA-256 ETag (`"sha256-..."`).
pub fn strong_etag(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut hex = String::with_capacity(32);
    for b in &digest[..16] {
        use std::fmt::Write;
        let _ = write!(&mut hex, "{b:02x}");
    }
    format!("\"{hex}\"")
}

/// Parse `Accept-Encoding` header and return true if `gzip` (with `q > 0`) is accepted.
pub fn accepts_gzip(header: &str) -> bool {
    if header.trim().is_empty() {
        return false;
    }
    let mut wildcard_ok = false;
    for part in header.split(',') {
        let mut segments = part.split(';');
        let Some(enc) = segments.next().map(|s| s.trim().to_ascii_lowercase()) else {
            continue;
        };
        if enc != "gzip" && enc != "x-gzip" && enc != "*" {
            continue;
        }
        let mut q_zero = false;
        for param in segments {
            let p = param.trim();
            if let Some(qval) = p.strip_prefix("q=").or_else(|| p.strip_prefix("Q=")) {
                if let Ok(q) = qval.trim().parse::<f32>() {
                    if q <= 0.0 {
                        q_zero = true;
                    }
                }
            }
        }
        if enc == "*" {
            wildcard_ok = !q_zero;
        } else {
            return !q_zero;
        }
    }
    wildcard_ok
}

/// Return true if `If-None-Match` contains `*` or a strong ETag matching `etag`.
pub fn if_none_match_matches(header: &str, etag: &str) -> bool {
    let trimmed = header.trim();
    if trimmed.is_empty() {
        return false;
    }
    if trimmed == "*" {
        return true;
    }
    trimmed
        .split(',')
        .map(str::trim)
        .any(|candidate| candidate == etag || candidate == "*")
}

/// Pre-built HTTP/1.1 byte responses for the embedded single-file frontend bundle.
pub struct EmbeddedHtmlCache {
    pub etag: String,
    resp_raw: Vec<u8>,
    resp_gzip: Vec<u8>,
    resp_304: Vec<u8>,
    resp_head_raw: Vec<u8>,
    resp_head_gzip: Vec<u8>,
}

impl EmbeddedHtmlCache {
    pub fn new(raw_html: &[u8]) -> Self {
        let etag = strong_etag(raw_html);
        let gz = gzip_compress(raw_html);

        let raw_hdr = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nETag: {etag}\r\nVary: Accept-Encoding\r\nCache-Control: no-cache\r\n{SECURITY_HEADERS}Content-Length: {}\r\nConnection: close\r\n\r\n",
            raw_html.len()
        );
        let mut resp_raw = Vec::with_capacity(raw_hdr.len() + raw_html.len());
        resp_raw.extend_from_slice(raw_hdr.as_bytes());
        resp_raw.extend_from_slice(raw_html);

        let gz_hdr = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Encoding: gzip\r\nETag: {etag}\r\nVary: Accept-Encoding\r\nCache-Control: no-cache\r\n{SECURITY_HEADERS}Content-Length: {}\r\nConnection: close\r\n\r\n",
            gz.len()
        );
        let mut resp_gzip = Vec::with_capacity(gz_hdr.len() + gz.len());
        resp_gzip.extend_from_slice(gz_hdr.as_bytes());
        resp_gzip.extend_from_slice(&gz);

        let resp_304 = format!(
            "HTTP/1.1 304 Not Modified\r\nETag: {etag}\r\nVary: Accept-Encoding\r\nCache-Control: no-cache\r\n{SECURITY_HEADERS}Connection: close\r\n\r\n"
        )
        .into_bytes();

        Self {
            etag,
            resp_raw,
            resp_gzip,
            resp_304,
            resp_head_raw: raw_hdr.into_bytes(),
            resp_head_gzip: gz_hdr.into_bytes(),
        }
    }

    pub fn global(raw_html: &'static [u8]) -> &'static Self {
        static CACHE: OnceLock<EmbeddedHtmlCache> = OnceLock::new();
        CACHE.get_or_init(|| Self::new(raw_html))
    }

    pub fn response_bytes(
        &self,
        is_head: bool,
        accept_encoding: &str,
        if_none_match: &str,
    ) -> &[u8] {
        if if_none_match_matches(if_none_match, &self.etag) {
            return &self.resp_304;
        }
        let gz = accepts_gzip(accept_encoding);
        match (is_head, gz) {
            (true, true) => &self.resp_head_gzip,
            (true, false) => &self.resp_head_raw,
            (false, true) => &self.resp_gzip,
            (false, false) => &self.resp_raw,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::process::{Command, Stdio};

    fn gunzip_with_system_gzip(gz: &[u8]) -> Vec<u8> {
        let mut child = Command::new("gzip")
            .arg("-d")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn gzip -d");
        let mut stdin = child.stdin.take().unwrap();
        let data = gz.to_vec();
        let writer = std::thread::spawn(move || {
            let _ = stdin.write_all(&data);
        });
        let out = child.wait_with_output().expect("wait gzip -d");
        writer.join().unwrap();
        assert!(
            out.status.success(),
            "gzip -d failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        out.stdout
    }

    #[test]
    fn gzip_roundtrips_empty_small_repetitive_and_real_html() {
        let samples: Vec<Vec<u8>> = vec![
            Vec::new(),
            b"a".to_vec(),
            b"hello world! ".repeat(500),
            (0..2048).map(|i| ((i * 73 + 19) % 251) as u8).collect(),
            include_bytes!("../assets/index.html").to_vec(),
        ];
        for (idx, sample) in samples.iter().enumerate() {
            let gz = gzip_compress(sample);
            let round = gunzip_with_system_gzip(&gz);
            assert_eq!(&round, sample, "sample #{idx} mismatch after gunzip");
        }
        let html = include_bytes!("../assets/index.html");
        let html_gz = gzip_compress(html);
        assert!(
            html_gz.len() * 10 < html.len() * 6,
            "expected >40% compression on index.html: raw={}, gz={}",
            html.len(),
            html_gz.len()
        );
    }

    #[test]
    fn etag_and_accept_encoding_negotiate_correctly() {
        assert!(accepts_gzip("gzip, deflate, br"));
        assert!(accepts_gzip("deflate, gzip;q=0.8"));
        assert!(!accepts_gzip("gzip;q=0, br"));
        assert!(!accepts_gzip("br, zstd"));

        let cache = EmbeddedHtmlCache::new(b"<html><body>Fleet</body></html>");
        assert!(cache.etag.starts_with('"') && cache.etag.ends_with('"'));
        assert!(if_none_match_matches(&cache.etag, &cache.etag));
        assert!(if_none_match_matches(&format!("\"other\", {}", cache.etag), &cache.etag));
        assert!(!if_none_match_matches("\"other\"", &cache.etag));

        let r304 = cache.response_bytes(false, "gzip", &cache.etag);
        assert!(r304.starts_with(b"HTTP/1.1 304 Not Modified\r\n"));

        let rgz = cache.response_bytes(false, "gzip, deflate", "");
        let hdr_end = rgz.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
        let hdrs = std::str::from_utf8(&rgz[..hdr_end]).unwrap();
        assert!(hdrs.contains("Content-Encoding: gzip\r\n"));
        assert!(hdrs.contains("Vary: Accept-Encoding\r\n"));
        assert!(hdrs.contains("X-Content-Type-Options: nosniff\r\n"));
        assert!(hdrs.contains("X-Frame-Options: DENY\r\n"));
        assert!(hdrs.contains("Referrer-Policy: no-referrer\r\n"));
        assert_eq!(gunzip_with_system_gzip(&rgz[hdr_end + 4..]), b"<html><body>Fleet</body></html>");
    }
}
