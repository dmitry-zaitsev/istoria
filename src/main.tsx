import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { CliSetupGate } from "./components/CliSetupGate";
import "./styles/global.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <CliSetupGate>
      <App />
    </CliSetupGate>
  </React.StrictMode>
);
