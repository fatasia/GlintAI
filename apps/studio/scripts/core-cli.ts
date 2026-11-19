/** Thin dispatch only; all validation and side effects stay in the existing command modules. */
export async function runCoreCommand(
  command: "recipe" | "tasks" | "previz-controls",
  args: string[],
): Promise<void> {
  switch (command) {
    case "recipe":
      console.log(JSON.stringify(await (await import("./recipe-cli")).runRecipe(args), null, 2));
      return;
    case "tasks":
      process.exitCode = await (await import("./task-cli")).runTasks(args);
      return;
    case "previz-controls":
      process.exitCode = await (await import("./previz-controls-cli")).runPrevizControls(args);
  }
}
