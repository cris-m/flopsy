import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { createLogger } from '@flopsy/shared';
import type { Signal } from '@shared/types';

const log = createLogger('skill-registry');

/**
 * Skill effectiveness entry in registry.json
 *
 * Tracked separately from SKILL.md to avoid modifying agent-created files.
 */
export interface SkillEffectivenessEntry {
  effectiveness: number;
  successRate: number;
  useCount: number;
  successCount: number;
  failureCount: number;
  lastUsed: number;
  lastUpdated: number;
  tags?: string[];
}

/**
 * skill-registry.json structure
 *
 * Location: ~/.flopsybot/skill-registry.json
 *
 * {
 *   "web-research": {
 *     "effectiveness": 0.85,
 *     "successRate": 0.85,
 *     "useCount": 20,
 *     "successCount": 17,
 *     "failureCount": 3,
 *     "lastUsed": 1713379200000,
 *     "lastUpdated": 1713379200000
 *   },
 *   "data-extraction": {
 *     "effectiveness": 0.62,
 *     ...
 *   }
 * }
 */
export interface SkillRegistry {
  [skillName: string]: SkillEffectivenessEntry;
}

/**
 * SkillRegistry Manager
 *
 * Maintains skill effectiveness tracking in a separate JSON file.
 * Does NOT modify SKILL.md files — keeps agent-created skills immutable.
 *
 * Workflow:
 * 1. beforeInvoke: Load effectiveness from registry, inject top skills
 * 2. afterInvoke: Update effectiveness based on execution signals
 *
 * Usage:
 * const registry = new SkillRegistry();
 * const effectiveness = await registry.get('web-research');
 * await registry.update('web-research', signals);
 * const topSkills = await registry.topByEffectiveness(5);
 */
export class SkillRegistryManager {
  private registryPath: string;
  private cache: SkillRegistry = {};
  private dirty = false;

  constructor(registryPath?: string) {
    if (registryPath) {
      this.registryPath = registryPath;
    } else {
      const flopsybotDir = join(homedir(), '.flopsybot');
      this.registryPath = join(flopsybotDir, 'skill-registry.json');
    }
  }

  /**
   * Load registry from disk into memory cache
   */
  async load(): Promise<void> {
    try {
      if (!existsSync(this.registryPath)) {
        log.info({ path: this.registryPath }, 'Registry file not found, starting fresh');
        this.cache = {};
        return;
      }

      const content = await readFile(this.registryPath, 'utf-8');
      this.cache = JSON.parse(content) as SkillRegistry;
      log.info({ count: Object.keys(this.cache).length }, 'Skill registry loaded');
    } catch (err) {
      log.warn({ err, path: this.registryPath }, 'Failed to load skill registry');
      this.cache = {};
    }
  }

  /**
   * Flush cache to disk if dirty
   */
  async flush(): Promise<void> {
    if (!this.dirty) return;

    try {
      const dir = require('path').dirname(this.registryPath);
      await mkdir(dir, { recursive: true });
      await writeFile(this.registryPath, JSON.stringify(this.cache, null, 2), 'utf-8');
      this.dirty = false;
      log.debug({ path: this.registryPath }, 'Skill registry flushed');
    } catch (err) {
      log.error({ err }, 'Failed to flush skill registry');
    }
  }

  /**
   * Get skill effectiveness entry
   *
   * Example:
   * const entry = await registry.get('web-research');
   * if (entry?.effectiveness > 0.8) { use skill }
   */
  async get(skillName: string): Promise<SkillEffectivenessEntry | null> {
    await this.load();
    return this.cache[skillName] ?? null;
  }

  /**
   * Create or initialize a skill entry
   */
  async initialize(skillName: string, domain?: string): Promise<SkillEffectivenessEntry> {
    await this.load();

    if (this.cache[skillName]) {
      return this.cache[skillName];
    }

    const entry: SkillEffectivenessEntry = {
      effectiveness: 0.5,
      successRate: 0.5,
      useCount: 0,
      successCount: 0,
      failureCount: 0,
      lastUsed: 0,
      lastUpdated: Date.now(),
      tags: domain ? [domain] : [],
    };

    this.cache[skillName] = entry;
    this.dirty = true;
    log.info({ skillName, domain }, 'Skill entry initialized');
    return entry;
  }

  /**
   * Update skill effectiveness based on execution signals
   *
   * Example:
   * const signals = [
   *   { type: 'tool_outcome', strength: 0.8, toolSuccess: true },
   *   { type: 'metric', strength: 0.5, metric: 'latency_ms' }
   * ];
   * await registry.update('web-research', signals);
   */
  async update(skillName: string, signals: Signal[]): Promise<SkillEffectivenessEntry> {
    await this.load();

    let entry = this.cache[skillName];
    if (!entry) {
      entry = await this.initialize(skillName);
    }

    // Calculate success: total signal strength >= 0
    const totalStrength = signals.reduce((sum, s) => sum + (s.strength ?? 0), 0);
    const isSuccess = totalStrength >= 0;

    // Update counts
    entry.useCount += 1;
    entry.lastUsed = Date.now();
    entry.lastUpdated = Date.now();

    if (isSuccess) {
      entry.successCount += 1;
    } else {
      entry.failureCount += 1;
    }

    // Recalculate effectiveness using exponential smoothing
    // New effectiveness = (old * 0.7) + (signal-based * 0.3)
    const baseSuccessRate = entry.successCount / entry.useCount;
    const signalBased = Math.max(0, Math.min(1, 0.5 + totalStrength * 0.1));
    entry.successRate = baseSuccessRate;
    entry.effectiveness = entry.effectiveness * 0.7 + signalBased * 0.3;

    this.cache[skillName] = entry;
    this.dirty = true;

    log.debug(
      {
        skillName,
        useCount: entry.useCount,
        successCount: entry.successCount,
        effectiveness: entry.effectiveness.toFixed(2),
      },
      'Skill effectiveness updated',
    );

    return entry;
  }

  /**
   * Get top N skills sorted by effectiveness
   *
   * Example:
   * const topSkills = await registry.topByEffectiveness(5);
   * // Returns [{ name: 'web-research', effectiveness: 0.85 }, ...]
   */
  async topByEffectiveness(
    limit: number = 5,
  ): Promise<Array<{ name: string; effectiveness: number; successRate: number }>> {
    await this.load();

    return Object.entries(this.cache)
      .map(([name, entry]) => ({
        name,
        effectiveness: entry.effectiveness,
        successRate: entry.successRate,
      }))
      .sort((a, b) => b.effectiveness - a.effectiveness)
      .slice(0, limit);
  }

  /**
   * Get all skills in a domain
   */
  async getByDomain(domain: string): Promise<Array<{ name: string; entry: SkillEffectivenessEntry }>> {
    await this.load();

    return Object.entries(this.cache)
      .filter(([, entry]) => entry.tags?.includes(domain))
      .map(([name, entry]) => ({ name, entry }));
  }

  /**
   * Get all skills
   */
  async getAll(): Promise<SkillRegistry> {
    await this.load();
    return { ...this.cache };
  }

  /**
   * Reset a skill's effectiveness
   */
  async reset(skillName: string): Promise<void> {
    await this.load();
    if (this.cache[skillName]) {
      this.cache[skillName] = {
        effectiveness: 0.5,
        successRate: 0.5,
        useCount: 0,
        successCount: 0,
        failureCount: 0,
        lastUsed: 0,
        lastUpdated: Date.now(),
      };
      this.dirty = true;
      log.info({ skillName }, 'Skill reset to initial state');
    }
  }

  /**
   * Delete a skill from registry
   */
  async delete(skillName: string): Promise<void> {
    await this.load();
    if (this.cache[skillName]) {
      delete this.cache[skillName];
      this.dirty = true;
      log.info({ skillName }, 'Skill deleted from registry');
    }
  }
}
