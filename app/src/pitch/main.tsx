import "../migrateStorage";
import { createRoot } from "react-dom/client";
import "../index.css";
import "./pitch.css";
import { Pitch } from "./Pitch";

document.documentElement.dataset.theme = "dark";

// No StrictMode: the engine owns a WebGL context and workers and must mount exactly once.
createRoot(document.getElementById("root")!).render(<Pitch />);
