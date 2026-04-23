/**
 * Lesson Store
 *
 * Stores corrections: "Don't do X" rules
 * Prevents agent from repeating mistakes
 *
 * Example:
 * - rule: "Don't use inline code on Discord"
 * - reason: "User correction: formatting breaks"
 * - severity: "important"
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { Lesson } from '@shared/types';

export class LessonStore {
  private storePath: string;
  private cache: Map<string, Lesson> = new Map();
  private dirty = false;

  constructor() {
    const flopsybotDir = join(homedir(), '.flopsybot');
    this.storePath = join(flopsybotDir, 'lessons.json');

    if (!existsSync(flopsybotDir)) {
      mkdirSync(flopsybotDir, { recursive: true });
    }

    this.load();
  }

  private load(): void {
    try {
      if (!existsSync(this.storePath)) {
        this.cache = new Map();
        return;
      }

      const data = readFileSync(this.storePath, 'utf-8');
      const lessons: Lesson[] = JSON.parse(data);

      this.cache = new Map(lessons.map(l => [l.id, l]));
      this.dirty = false;
    } catch (error) {
      console.warn(`Failed to load lessons from ${this.storePath}:`, error);
      this.cache = new Map();
    }
  }

  private save(): void {
    try {
      const lessons = Array.from(this.cache.values());
      writeFileSync(this.storePath, JSON.stringify(lessons, null, 2), 'utf-8');
      this.dirty = false;
    } catch (error) {
      console.error(`Failed to save lessons to ${this.storePath}:`, error);
    }
  }

  /**
   * Get all lessons
   */
  getAll(): Lesson[] {
    return Array.from(this.cache.values());
  }

  /**
   * Get lessons by domain
   */
  getByDomain(domain: string): Lesson[] {
    return Array.from(this.cache.values()).filter(l => l.domain === domain);
  }

  /**
   * Get lessons by severity
   */
  getBySeverity(severity: 'minor' | 'important' | 'critical'): Lesson[] {
    return Array.from(this.cache.values()).filter(l => l.severity === severity);
  }

  /**
   * Record a new lesson from a correction
   */
  recordCorrection(
    rule: string,
    reason: string,
    domain?: string,
    severity: 'minor' | 'important' | 'critical' = 'important'
  ): Lesson {
    const id = `lesson_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    const lesson: Lesson = {
      id,
      rule,
      reason,
      domain,
      severity,
      recordedAt: Date.now(),
      preventionCount: 0,
      appliesTo: 'user:all',
      tags: [],
    };

    this.cache.set(id, lesson);
    this.dirty = true;

    return lesson;
  }

  /**
   * Mark that a lesson prevented a mistake
   */
  recordPrevention(lessonId: string): void {
    const lesson = this.cache.get(lessonId);
    if (lesson) {
      lesson.preventionCount += 1;
      this.dirty = true;
    }
  }

  /**
   * Delete a lesson
   */
  delete(id: string): void {
    if (this.cache.has(id)) {
      this.cache.delete(id);
      this.dirty = true;
    }
  }

  /**
   * Check if lesson already exists (avoid duplicates)
   */
  lessonExists(rule: string): Lesson | undefined {
    return Array.from(this.cache.values()).find(l =>
      l.rule.toLowerCase() === rule.toLowerCase()
    );
  }

  /**
   * Save to disk
   */
  flush(): void {
    if (this.dirty) {
      this.save();
    }
  }

  /**
   * Reload from disk
   */
  reload(): void {
    this.load();
  }
}
