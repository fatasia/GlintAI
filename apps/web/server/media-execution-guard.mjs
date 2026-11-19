export function installExecutionGuard(jobs, guard) {
  if (jobs.setExecutionGuard) jobs.setExecutionGuard(guard);
  else if (jobs.submit) {
    const original = jobs.submit.bind(jobs);
    jobs.submit = async (input, signal) => {
      await guard(
        input,
        jobs.protocol?.() === "openai-images" ? "openai-images" : "skills-gateway",
      );
      return original(input, signal);
    };
  }
  jobs.comfyui?.setExecutionGuard(guard);
}
