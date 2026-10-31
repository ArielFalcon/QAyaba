import type { LessonStorePort } from "@contexts/cross-run-learning/application/index";
import { getHistory } from "./persistence/index";

/* The lesson store over the history database: the engine's port on the repository the shell owns. */
export class SqliteLessonStoreAdapter implements LessonStorePort {
  async record(rows: Parameters<LessonStorePort["record"]>[0]): Promise<void> {
    getHistory().lessons.record(rows);
  }

  async listAdmitted(query: Parameters<LessonStorePort["listAdmitted"]>[0]): ReturnType<LessonStorePort["listAdmitted"]> {
    return getHistory().lessons.listAdmitted(query);
  }
}
