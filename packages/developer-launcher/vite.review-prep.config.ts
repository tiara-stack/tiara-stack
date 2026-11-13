import { library } from "tooling-config/vite";

export default library({
  test: {
    environment: "node",
    include: ["integration-tests/review-prep.integration.test.ts"],
  },
});
