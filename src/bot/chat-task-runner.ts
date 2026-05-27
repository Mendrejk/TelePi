import type { PiSessionContext } from "../pi-session.js";
import { getPiSessionContextKey } from "../pi-session.js";

export interface ChatTaskRunner {
  tryStartPrompt(
    target: PiSessionContext,
    promptText: string,
    task: () => Promise<void>,
  ): "started" | "queued";
}

export function createChatTaskRunner(deps: {
  beginProcessing: (target: PiSessionContext, promptText: string) => void;
  endProcessing: (target: PiSessionContext) => void;
  onTaskError: (error: unknown, target: PiSessionContext, promptText: string) => void;
}): ChatTaskRunner {
  const runningContexts = new Set<string>();
  const pendingTasks = new Set<Promise<void>>();
  const taskQueues = new Map<string, Array<() => Promise<void>>>();

  const processQueue = async (contextKey: string, target: PiSessionContext): Promise<void> => {
    const queue = taskQueues.get(contextKey);
    if (!queue || queue.length === 0) {
      runningContexts.delete(contextKey);
      taskQueues.delete(contextKey);
      deps.endProcessing(target);
      return;
    }

    const { task, promptText } = queue.shift() as any;
    
    let taskPromise!: Promise<void>;
    taskPromise = (async () => {
      try {
        await task();
      } catch (error) {
        deps.onTaskError(error, target, promptText);
      } finally {
        pendingTasks.delete(taskPromise);
        void processQueue(contextKey, target);
      }
    })();

    pendingTasks.add(taskPromise);
  };

  return {
    tryStartPrompt(target, promptText, task) {
      const contextKey = getPiSessionContextKey(target);
      
      if (runningContexts.has(contextKey)) {
        let queue = taskQueues.get(contextKey);
        if (!queue) {
          queue = [];
          taskQueues.set(contextKey, queue);
        }
        (queue as any).push({ task, promptText });
        return "queued";
      }

      runningContexts.add(contextKey);
      deps.beginProcessing(target, promptText);

      let queue = taskQueues.get(contextKey);
      if (!queue) {
        queue = [];
        taskQueues.set(contextKey, queue);
      }
      (queue as any).push({ task, promptText });
      
      void processQueue(contextKey, target);

      return "started";
    },
  };
}
