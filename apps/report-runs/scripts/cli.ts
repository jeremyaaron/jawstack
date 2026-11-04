import { runCli } from "../src/cli";
void runCli(process.argv.slice(2), (data) => {
  process.stdout.write(data);
}).catch(() => {
  process.stderr.write(
    JSON.stringify({
      ok: false,
      error: { code: "cli.failed", message: "Invalid arguments or report API operation failed." },
    }) + "\n",
  );
  process.exitCode = 1;
});
