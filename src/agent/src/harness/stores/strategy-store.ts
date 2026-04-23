/**
 * Strategy Store
 *
 * Loads/saves strategies from disk (~/.flopsybot/strategies.json)
 * Strategies are what works: effectiveness scores, use counts, etc.
 *
 * Real-time learning: Strategy scores change as agent learns
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { Strategy } from '@shared/types';

export class StrategyStore {
  private storePath: string;
  private cache: Map<string, Strategy> = new Map();
  private dirty = false;

  constructor() {
    const flopsybotDir = join(homedir(), '.flopsybot');
    this.storePath = join(flopsybotDir, 'strategies.json');

    // Ensure directory exists
    if (!existsSync(flopsybotDir)) {
      mkdirSync(flopsybotDir, { recursive: true });
    }

    this.load();
  }

  /**
   * Load strategies from disk into cache
   */
  private load(): void {
    try {
      if (!existsSync(this.storePath)) {
        this.cache = new Map();
        return;
      }

      const data = readFileSync(this.storePath, 'utf-8');
      const strategies: Strategy[] = JSON.parse(data);

      this.cache = new Map(strategies.map(s => [s.id, s]));
      this.dirty = false;
    } catch (error) {
      console.warn(`Failed to load strategies from ${this.storePath}:`, error);
      this.cache = new Map();
    }
  }

  /**
   * Save strategies to disk
   */
  private save(): void {
    try {
      const strategies = Array.from(this.cache.values());
      writeFileSync(this.storePath, JSON.stringify(strategies, null, 2), 'utf-8');
      this.dirty = false;
    } catch (error) {
      console.error(`Failed to save strategies to ${this.storePath}:`, error);
    }
  }

  /**
   * Get all strategies for a user
   */
  getAll(): Strategy[] {
    return Array.from(this.cache.values());
  }

  /**
   * Get strategy by ID
   */
  get(id: string): Strategy | undefined {
    return this.cache.get(id);
  }

  /**
   * Get top N strategies by effectiveness
   */
  getTopByEffectiveness(count: number = 5): Strategy[] {
    return Array.from(this.cache.values())
      .sort((a, b) => b.effectiveness - a.effectiveness)
      .slice(0, count);
  }

  /**
   * Get strategies by domain
   */
  getByDomain(domain: string): Strategy[] {
    return Array.from(this.cache.values()).filter(s => s.domain === domain);
  }

  /**
   * Update effectiveness score for a strategy
   *
   * This is the core real-time learning function:
   * effectiveness *= (1 + signal.strength * 0.1)
   * clamped to [0.2, 1.0]
   */
  updateEffectiveness(strategyId: string, signalStrength: number): void {
    const strategy = this.cache.get(strategyId);
    if (!strategy) return;

    const boost = signalStrength * 0.1;
    strategy.effectiveness *= 1 + boost;

    // Clamp to [0.2, 1.0]
    strategy.effectiveness = Math.max(0.2, Math.min(1.0, strategy.effectiveness));

    strategy.uses += 1;
    strategy.lastUsed = Date.now();
    strategy.refinements += 1;

    this.dirty = true;
  }

  /**
   * Create a new strategy
   */
  create(strategy: Omit<Strategy, 'id'>): Strategy {
    const id = `strategy_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const newStrategy: Strategy = {
      ...strategy,
      id,
    };

    this.cache.set(id, newStrategy);
    this.dirty = true;

    return newStrategy;
  }

  /**
   * Delete a strategy
   */
  delete(id: string): void {
    if (this.cache.has(id)) {
      this.cache.delete(id);
      this.dirty = true;
    }
  }

  /**
   * Mark all for update and save
   */
  flush(): void {
    if (this.dirty) {
      this.save();
    }
  }

  /**
   * Force refresh from disk
   */
  reload(): void {
    this.load();
  }
}

// ★ Insight ─────────────────────────────────────────
// StrategyStore is a simple file-based store that caches strategies
// in memory for fast access, but marks as "dirty" when changed.
// This allows batch saves (multiple updates → one disk write).
// Alternative: could use SQLite or PostgreSQL for more complex queries.
// ─────────────────────────────────────────────────
