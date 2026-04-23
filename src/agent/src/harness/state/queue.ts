import type { StateStore } from './store';
import type { QueuedItem, DeliveryTarget } from '@shared/types';

const MAX_QUEUE_SIZE = 200;

export class QueueManager {
  constructor(private store: StateStore) {}

  async enqueue(item: Omit<QueuedItem, 'id' | 'createdAt'>): Promise<void> {
    await this.store.mutate((state) => {
      const entry: QueuedItem = {
        ...item,
        id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        createdAt: Date.now(),
      };
      state.queue.push(entry);
      state.queue.sort((a, b) => b.priority - a.priority);
      if (state.queue.length > MAX_QUEUE_SIZE) {
        state.queue.length = MAX_QUEUE_SIZE;
      }
    });
  }

  async flush(): Promise<QueuedItem[]> {
    return this.store.mutate((state) => {
      const items = [...state.queue];
      state.queue = [];
      return items;
    });
  }

  async peek(limit = 10): Promise<QueuedItem[]> {
    return this.store.getQueue().slice(0, limit);
  }

  async size(): Promise<number> {
    return this.store.getQueue().length;
  }

  async remove(id: string): Promise<boolean> {
    return this.store.mutate((state) => {
      const idx = state.queue.findIndex((item) => item.id === id);
      if (idx === -1) return false;
      state.queue.splice(idx, 1);
      return true;
    });
  }
}
