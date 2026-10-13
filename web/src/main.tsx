import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import AlertForm from "./AlertForm";
import "./alert-form.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AlertForm />
  </StrictMode>,
);
