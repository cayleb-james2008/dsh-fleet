import { createRoot } from "react-dom/client";
import { LazyMotion, MotionConfig, domAnimation } from "motion/react";
import "./index.css";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <LazyMotion features={domAnimation}>
    <MotionConfig reducedMotion="user">
      <App />
    </MotionConfig>
  </LazyMotion>,
);
