import "../migrateStorage";
import { createRoot } from "react-dom/client";
import "../index.css";
import "./pitch.css";
import { GRID } from "../config/grid";
import { Pitch } from "./Pitch";

document.documentElement.dataset.theme = "dark";

// The whole story is built ahead and kept (story.ts prewarms every step): a cache big enough that
// nothing built for a later step is dropped before the camera gets there.
GRID.cacheChunks = 1600;

// No StrictMode: the engine owns a WebGL context and workers and must mount exactly once.
createRoot(document.getElementById("root")!).render(<Pitch />);
