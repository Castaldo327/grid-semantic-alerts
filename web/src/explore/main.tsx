import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import ExploreApp from "./App";
import "../styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ExploreApp />
  </StrictMode>,
);
