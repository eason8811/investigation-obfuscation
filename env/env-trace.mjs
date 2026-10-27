import {mkdirSync, createWriteStream} from "node:fs";
import {dirname, resolve} from "node:path";
import {finished} from "node:stream/promises";

export function createTrace(filePath) {
  const outputPath = resolve(filePath);

  mkdirSync(dirname(outputPath), {
    recursive: true
  });

  const stream = createWriteStream(outputPath, {
    flags: "w",
    encoding: "utf8"
  });

  let sequence = 0;
  let currentStage = "environment";
  let writeError = null;

  stream.on("error", error => {
    writeError = error;
  });

  function emit(type, data = {}) {
    if (closed) {
      return false;
    }

    if (writeError) {
      throw writeError;
    }

    const record = {
      seq: ++sequence,
      timestamp: new Date().toISOString(),
      stage: currentStage,
      type,
      ...data
    };

    return stream.write(JSON.stringify(record) + "\n");
  }

  async function stage(name, action) {
    const previousStage = currentStage;
    currentStage = name;

    const start = performance.now();

    emit("stage.start", {name});

    console.log(`[Castle] ${name} ...`);

    try {
      const result = await action();

      const durationMs = performance.now() - start;

      emit("stage.success", {
        name,
        durationMs
      });

      console.log(
        `[Castle] ${name} SUCCESS (${durationMs.toFixed(2)}ms)`
      );

      return result;
    } catch (error) {
      emit("stage.error", {
        name,
        durationMs: performance.now() - start,
        error: {
          name: error?.name,
          message: error?.message,
          stack: error?.stack
        }
      });

      console.error(`[Castle] ${name} FAILED`);

      throw error;
    }
  }

  async function close() {
    if (closed) {
      return;
    }
    closed = true;
    stream.end();
    await finished(stream);
  }

  return {
    emit,
    stage,
    close,
    outputPath
  };
}