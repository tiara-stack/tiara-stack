import path from "node:path";

type PathOperations = Pick<typeof path, "relative" | "isAbsolute" | "sep">;

export const isPreviewPathWithin = (
  parent: string,
  candidate: string,
  pathOperations: PathOperations = path,
) => {
  const relative = pathOperations.relative(parent, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${pathOperations.sep}`) &&
      !pathOperations.isAbsolute(relative))
  );
};
