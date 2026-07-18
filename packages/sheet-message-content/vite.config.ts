import { fileURLToPath } from "url";
import { browserLibrary } from "tooling-config/vite";

export default browserLibrary({
  pack: {
    entry: {
      index: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
      text: fileURLToPath(new URL("./src/text.ts", import.meta.url)),
      components: fileURLToPath(new URL("./src/components.ts", import.meta.url)),
      roomOrderContent: fileURLToPath(new URL("./src/roomOrderContent.ts", import.meta.url)),
      rendering: fileURLToPath(new URL("./src/rendering.ts", import.meta.url)),
      checkinMessages: fileURLToPath(new URL("./src/checkinMessages.ts", import.meta.url)),
      slotRendering: fileURLToPath(new URL("./src/slotRendering.ts", import.meta.url)),
      teamSubmissionButtons: fileURLToPath(
        new URL("./src/teamSubmissionButtons.ts", import.meta.url),
      ),
      checkinPrompt: fileURLToPath(new URL("./src/checkinPrompt.ts", import.meta.url)),
      checkinAnnouncement: fileURLToPath(new URL("./src/checkinAnnouncement.ts", import.meta.url)),
      roomOrderMessage: fileURLToPath(new URL("./src/roomOrderMessage.ts", import.meta.url)),
    },
    deps: { neverBundle: ["effect"] },
  },
});
