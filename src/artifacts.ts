// Persistent artifact storage was removed in favor of the one-shot
// download_artifact workspace handoff. Keep this re-export temporarily so
// downstream source imports of ArtifactError have a deliberate migration path.
export { ArtifactError } from "./artifact-error.js";
