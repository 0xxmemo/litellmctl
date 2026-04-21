import { createRoot } from "react-dom/client";
import { App } from "./src/app";
import "./src/index.css";

const elem = document.getElementById("root")!;

if (import.meta.hot) {
  // HMR support
  const root = (import.meta.hot.data.root ??= createRoot(elem));
  root.render(<App />);
} else {
  createRoot(elem).render(<App />);
}
