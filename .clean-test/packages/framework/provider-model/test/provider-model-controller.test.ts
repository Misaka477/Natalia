import { expect, test } from "bun:test";
import type { ProviderModelControllerInput } from "../src";
import { createProviderModelController } from "../src";

function controllerInput(
  onInitialize: () => void,
): ProviderModelControllerInput {
  return {
    initialize: onInitialize,
    runnerInput: () => {
      throw new Error("runner input should remain lazy");
    },
    commands: {
      catalog: async () => [],
      select: async () => undefined,
    },
    navi: {
      available: () => false,
      publish() {},
      runBody: async () => undefined,
      wake: async () => undefined,
    },
    nia: {
      available: () => false,
      publish() {},
      runBody: async () => undefined,
      wake: async () => undefined,
    },
  };
}

test("provider model controller initializes and disposes chat work", async () => {
  let initialized = 0;
  const controller = createProviderModelController(
    controllerInput(() => {
      initialized += 1;
    }),
  );
  expect(initialized).toBe(1);

  await controller.dispose();
  await expect(
    controller.runNaviChatTurn({
      sessionID: "ses_test" as never,
      text: "hello",
      responseMessageID: "msg_1",
    }),
  ).rejects.toThrow("provider/model controller disposed");
});

test.each(["navi", "nia"] as const)(
  "aborting %s leaves the other stream busy",
  async (stream) => {
    const input = controllerInput(() => {});
    const events: string[] = [];
    const signals = new Map<string, AbortSignal>();
    let finishNavi!: () => void;
    let finishNia!: () => void;
    const naviDone = new Promise<void>((resolve) => {
      finishNavi = resolve;
    });
    const niaDone = new Promise<void>((resolve) => {
      finishNia = resolve;
    });
    input.navi = {
      available: () => true,
      publish: (_, event) => {
        events.push(event.type);
      },
      runBody: async (_, signal) => {
        signals.set("navi", signal);
        await naviDone;
        signal.throwIfAborted();
      },
      wake: async () => {},
    };
    input.nia = {
      available: () => true,
      publish: (_, event) => {
        events.push(event.type);
      },
      runBody: async (_, signal) => {
        signals.set("nia", signal);
        await niaDone;
        signal.throwIfAborted();
      },
      wake: async () => {},
    };
    const controller = createProviderModelController(input);
    const sessionID = "ses_parallel" as never;
    const turn = { sessionID, responseMessageID: "same-id", text: "hello" };
    const naviTask = controller.runNaviChatTurn(turn);
    const niaTask = controller.runNiaChatTurn(turn);
    const settled = Promise.allSettled([naviTask, niaTask]);
    await Promise.resolve();
    expect(controller.naviBusy(sessionID)).toBe(true);
    expect(controller.niaBusy(sessionID)).toBe(true);
    expect(
      stream === "nia"
        ? controller.abortNia(sessionID)
        : controller.abortNavi(sessionID),
    ).toBe(true);
    expect(signals.get(stream)!.aborted).toBe(true);
    expect(signals.get(stream === "navi" ? "nia" : "navi")!.aborted).toBe(
      false,
    );
    finishNavi();
    finishNia();
    const outcomes = await settled;
    expect(outcomes[stream === "navi" ? 0 : 1]!.status).toBe("rejected");
    expect(outcomes[stream === "navi" ? 1 : 0]!.status).toBe("fulfilled");
    expect(events).toContain("navi.chat.turn.started");
    expect(events).toContain("nia.chat.turn.started");
    expect(events).toContain("navi.chat.turn.finished");
    expect(events).toContain("nia.chat.turn.finished");
    expect(controller.naviBusy(sessionID)).toBe(false);
    expect(controller.niaBusy(sessionID)).toBe(false);
    await controller.dispose();
  },
);

test("each wake waits only for its own stream and calls its own callback", async () => {
  const input = controllerInput(() => {});
  let finish!: () => void;
  const busy = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let niaWoke!: () => void;
  const niaWake = new Promise<void>((resolve) => {
    niaWoke = resolve;
  });
  let naviWoke!: () => void;
  const naviWake = new Promise<void>((resolve) => {
    naviWoke = resolve;
  });
  let naviWakeCount = 0;
  input.navi.available = input.nia.available = () => true;
  input.navi.runBody = async () => busy;
  input.navi.wake = async () => {
    naviWakeCount++;
    naviWoke();
  };
  input.nia.wake = async () => {
    niaWoke();
  };
  const controller = createProviderModelController(input);
  const sessionID = "ses_wake" as never;
  const task = controller.runNaviChatTurn({
    sessionID,
    text: "hello",
    responseMessageID: "navi",
  });
  controller.requestNaviWake(sessionID);
  controller.requestNiaWake(sessionID);
  await niaWake;
  expect(naviWakeCount).toBe(0);
  expect(controller.naviBusy(sessionID)).toBe(true);
  finish();
  await task;
  await naviWake;
  expect(naviWakeCount).toBe(1);
  await controller.dispose();
});

test.each(["navi", "nia"] as const)(
  "abort %s cancels its queued wake without discarding peer wake",
  async (stream) => {
    const input = controllerInput(() => {});
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const wakes: string[] = [];
    for (const name of ["navi", "nia"] as const) {
      input[name].available = () => true;
      input[name].runBody = async (_, signal) => {
        await blocked;
        signal.throwIfAborted();
      };
      input[name].wake = async () => {
        wakes.push(name);
      };
    }
    const controller = createProviderModelController(input);
    const sessionID = "ses_abort_wake" as never;
    const task =
      stream === "nia"
        ? controller.runNiaChatTurn({
            sessionID,
            responseMessageID: stream,
            text: "work",
          })
        : controller.runNaviChatTurn({
            sessionID,
            responseMessageID: stream,
            text: "work",
          });
    const settled = Promise.allSettled([task]);
    controller.requestNaviWake(sessionID);
    controller.requestNiaWake(sessionID);
    // Let the wake coordinator start waiting on the in-flight task.
    await Promise.resolve();
    await Promise.resolve();
    stream === "nia"
      ? controller.abortNia(sessionID)
      : controller.abortNavi(sessionID);
    release();
    await settled;
    await Promise.resolve();
    expect(wakes).toEqual([stream === "navi" ? "nia" : "navi"]);
    await controller.dispose();
  },
);

test("synchronous stream failures release busy ownership", async () => {
  const input = controllerInput(() => {});
  input.nia.available = () => true;
  input.nia.runBody = () => {
    throw new Error("synchronous failure");
  };
  const controller = createProviderModelController(input);
  const sessionID = "ses_sync_failure" as never;
  await expect(
    controller.runNiaChatTurn({
      sessionID,
      responseMessageID: "nia",
      text: "work",
    }),
  ).rejects.toThrow("synchronous failure");
  expect(controller.niaBusy(sessionID)).toBe(false);
  await controller.dispose();
});

test("same-stream ownership remains isolated across sessions", async () => {
  const input = controllerInput(() => {});
  const signals = new Map<string, AbortSignal>();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  input.nia.available = () => true;
  input.nia.runBody = async (turn, signal) => {
    signals.set(turn.sessionID, signal);
    await blocked;
    signal.throwIfAborted();
  };
  const controller = createProviderModelController(input);
  const a = "ses_nia_a" as never;
  const b = "ses_nia_b" as never;
  const tasks = [a, b].map((sessionID) =>
    controller.runNiaChatTurn({
      sessionID,
      text: "audit",
      responseMessageID: "same-id",
    }),
  );
  const settled = Promise.allSettled(tasks);
  await Promise.resolve();
  expect(controller.niaBusy(a)).toBe(true);
  expect(controller.niaBusy(b)).toBe(true);
  controller.abortNia(a);
  expect(signals.get(a)!.aborted).toBe(true);
  expect(signals.get(b)!.aborted).toBe(false);
  release();
  expect((await settled).map((result) => result.status)).toEqual([
    "rejected",
    "fulfilled",
  ]);
  await controller.dispose();
});

test("dispose aborts both streams and discards their pending wakes", async () => {
  const input = controllerInput(() => {});
  const signals: AbortSignal[] = [];
  let wakes = 0;
  for (const stream of [input.navi, input.nia]) {
    stream.available = () => true;
    stream.runBody = async (_, signal) => {
      signals.push(signal);
      await new Promise<void>((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    };
    stream.wake = async () => {
      wakes++;
    };
  }
  const controller = createProviderModelController(input);
  const turn = {
    sessionID: "ses_dispose" as never,
    text: "work",
    responseMessageID: "same",
  };
  const outcomes = Promise.allSettled([
    controller.runNaviChatTurn(turn),
    controller.runNiaChatTurn(turn),
  ]);
  controller.requestNaviWake(turn.sessionID);
  controller.requestNiaWake(turn.sessionID);
  await Promise.resolve();
  await controller.dispose();
  expect(signals).toHaveLength(2);
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  expect((await outcomes).every((result) => result.status === "rejected")).toBe(
    true,
  );
  expect(wakes).toBe(0);
  expect(controller.naviBusy(turn.sessionID)).toBe(false);
  expect(controller.niaBusy(turn.sessionID)).toBe(false);
});

test.each(["navi", "nia"] as const)(
  "failed %s start publication does not orphan its provider body",
  async (stream) => {
    const input = controllerInput(() => {});
    let bodies = 0;
    input[stream].available = () => true;
    input[stream].runBody = async () => {
      bodies++;
    };
    input[stream].publish = (_, event) => {
      if (event.type.endsWith(".turn.started"))
        throw new Error("publish failed");
    };
    const controller = createProviderModelController(input);
    const sessionID = "ses_publish_fail" as never;
    await expect(
      stream === "nia"
        ? controller.runNiaChatTurn({
            sessionID,
            text: "work",
            responseMessageID: "test",
          })
        : controller.runNaviChatTurn({
            sessionID,
            text: "work",
            responseMessageID: "test",
          }),
    ).rejects.toThrow("publish failed");
    expect(bodies).toBe(0);
    expect(
      stream === "nia"
        ? controller.niaBusy(sessionID)
        : controller.naviBusy(sessionID),
    ).toBe(false);
    input[stream].publish = () => {};
    await (stream === "nia"
      ? controller.runNiaChatTurn({
          sessionID,
          text: "retry",
          responseMessageID: "next",
        })
      : controller.runNaviChatTurn({
          sessionID,
          text: "retry",
          responseMessageID: "next",
        }));
    expect(bodies).toBe(1);
    await controller.dispose();
  },
);
