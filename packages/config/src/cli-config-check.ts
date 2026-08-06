// CLI：配置诊断检查。--env 覆盖环境；--missing-required 删除密钥后应失败。
import { ConfigError, loadConfig, redactConfig } from "./index.js";

interface CliArgs {
  env: string | undefined;
  missingRequired: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { env: undefined, missingRequired: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--env") {
      args.env = argv[i + 1];
      i++;
    } else if (arg === "--missing-required") {
      args.missingRequired = true;
    }
  }
  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (args.env !== undefined) env.NODE_ENV = args.env;
  if (args.missingRequired) {
    delete env.SESSION_KEY;
    delete env.CSRF_KEY;
    delete env.POSTGRES_PASSWORD;
  }

  try {
    const config = loadConfig(env);
    console.log("config:check — OK");
    console.log(JSON.stringify(redactConfig(config), null, 2));
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error("config:check — 校验失败");
      for (const field of err.fieldErrors) {
        console.error(`  ${field.path}: ${field.code} — ${field.message}`);
      }
    } else {
      console.error(err);
    }
    process.exitCode = 1;
  }
}

main();
