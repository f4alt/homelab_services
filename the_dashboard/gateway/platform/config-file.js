import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const BIND_MOUNT_REPLACE_ERROR_CODE = "EBUSY";
const CONFIG_FILE_MODE = 0o644;

export async function writeConfigFile(configPath, source, fileSystem = fs) {
  const directory = path.dirname(configPath);
  const filename = path.basename(configPath);
  const tempPath = path.join(
    directory,
    `.${filename}.${process.pid}.${randomUUID()}.tmp`
  );

  try {
    await fileSystem.writeFile(tempPath, source, {
      encoding: "utf8",
      mode: CONFIG_FILE_MODE
    });

    try {
      await fileSystem.rename(tempPath, configPath);
    } catch (error) {
      if (error?.code !== BIND_MOUNT_REPLACE_ERROR_CODE) throw error;

      // A bind-mounted file cannot be replaced as a directory entry, but its
      // contents can still be updated from the fully written temporary file.
      await fileSystem.copyFile(tempPath, configPath);
    }
  } finally {
    // The destination is authoritative; cleanup must not turn a successful
    // save into an error if the temporary file has already been replaced.
    await fileSystem.unlink(tempPath).catch(() => {});
  }
}
