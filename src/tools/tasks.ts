export type TaskStatus = "pending" | "in_progress" | "completed";

export interface Task {
  id: string;
  description: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  messages: string[];
}

export class TaskStore {
  private tasks = new Map<string, Task>();
  private counter = 0;

  create(description: string, status?: TaskStatus): Task {
    const id = `task_${++this.counter}`;
    const now = Date.now();
    const task: Task = {
      id,
      description,
      status: status ?? "pending",
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    this.tasks.set(id, task);
    return task;
  }

  update(id: string, status?: TaskStatus, message?: string): Task {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    if (status !== undefined) task.status = status;
    if (message !== undefined) task.messages.push(message);
    task.updatedAt = Date.now();
    return task;
  }

  get(id: string): Task {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    return task;
  }

  list(): Task[] {
    return Array.from(this.tasks.values());
  }

  clear(): void {
    this.tasks.clear();
    this.counter = 0;
  }
}

export const taskStore = new TaskStore();

const STATUS_ICON: Record<TaskStatus, string> = {
  pending: " ",
  in_progress: ">",
  completed: "*",
};

export function formatTaskList(tasks: Task[]): string {
  if (tasks.length === 0) return "No tasks.";
  const lines = [`Tasks (${tasks.length}):`];
  for (const t of tasks) {
    const icon = STATUS_ICON[t.status];
    lines.push(`  [${icon}] ${t.id}  ${t.description}  (${t.status})`);
  }
  return lines.join("\n");
}

export function formatTaskDetail(task: Task): string {
  const lines = [
    `${task.id}: ${task.description}`,
    `Status: ${task.status}`,
    `Created: ${new Date(task.createdAt).toISOString()}`,
    `Updated: ${new Date(task.updatedAt).toISOString()}`,
  ];
  if (task.messages.length > 0) {
    lines.push("Messages:");
    for (const m of task.messages) {
      lines.push(`  - ${m}`);
    }
  }
  return lines.join("\n");
}
