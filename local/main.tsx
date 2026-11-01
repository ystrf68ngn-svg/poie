import React from "react";
import { createRoot } from "react-dom/client";
import AgentWorkspace from "../components/agent-workspace";
import "../app/globals.css";
createRoot(document.getElementById("root")!).render(<AgentWorkspace />);
