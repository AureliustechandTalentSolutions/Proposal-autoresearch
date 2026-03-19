/**
 * System Tray Notifier
 *
 * Sends system tray notifications for key events in the autonomous
 * workbench: task completions, approval requests, compliance alerts,
 * and RFP detections.
 */

import type { AutonomyLevel } from "../../shared/types";

export type NotificationPriority = "low" | "normal" | "high" | "critical";
export type NotificationCategory =
  | "task_complete"
  | "task_failed"
  | "approval_required"
  | "compliance_alert"
  | "rfp_detected"
  | "loop_status"
  | "system"
  | "security";

export interface Notification {
  id: string;
  title: string;
  body: string;
  category: NotificationCategory;
  priority: NotificationPriority;
  timestamp: number;
  read: boolean;
  actionUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface NotifierConfig {
  /** Enable system tray notifications */
  enabled: boolean;
  /** Minimum priority level to show as system notification */
  minSystemPriority: NotificationPriority;
  /** Categories to suppress */
  suppressedCategories: NotificationCategory[];
  /** Maximum notifications to retain */
  maxRetained: number;
  /** Sound for critical notifications */
  criticalSound: boolean;
}

const DEFAULT_CONFIG: NotifierConfig = {
  enabled: true,
  minSystemPriority: "normal",
  suppressedCategories: [],
  maxRetained: 500,
  criticalSound: true,
};

const PRIORITY_ORDER: Record<NotificationPriority, number> = {
  low: 0,
  normal: 1,
  high: 2,
  critical: 3,
};

export class Notifier {
  private config: NotifierConfig;
  private notifications: Notification[] = [];
  private listeners: Map<string, (notification: Notification) => void> = new Map();

  constructor(config?: Partial<NotifierConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Send a notification to the system tray and internal log.
   */
  notify(params: {
    title: string;
    body: string;
    category: NotificationCategory;
    priority?: NotificationPriority;
    actionUrl?: string;
    metadata?: Record<string, unknown>;
  }): Notification {
    const priority = params.priority ?? "normal";

    const notification: Notification = {
      id: crypto.randomUUID(),
      title: params.title,
      body: params.body,
      category: params.category,
      priority,
      timestamp: Date.now(),
      read: false,
      actionUrl: params.actionUrl,
      metadata: params.metadata,
    };

    this.notifications.push(notification);
    this.trimNotifications();

    // Emit to listeners
    for (const listener of this.listeners.values()) {
      try {
        listener(notification);
      } catch {
        // Listener errors should not propagate
      }
    }

    // Send system tray notification if enabled and above threshold
    if (this.shouldShowSystem(notification)) {
      this.sendSystemNotification(notification);
    }

    return notification;
  }

  /**
   * Convenience: notify about a task completion.
   */
  notifyTaskComplete(taskType: string, taskId: string): Notification {
    return this.notify({
      title: "Task Complete",
      body: `${taskType} (${taskId.slice(0, 8)}) finished successfully`,
      category: "task_complete",
      priority: "normal",
    });
  }

  /**
   * Convenience: notify about a task failure.
   */
  notifyTaskFailed(taskType: string, taskId: string, error: string): Notification {
    return this.notify({
      title: "Task Failed",
      body: `${taskType} (${taskId.slice(0, 8)}): ${error}`,
      category: "task_failed",
      priority: "high",
    });
  }

  /**
   * Convenience: notify that human approval is needed.
   */
  notifyApprovalRequired(operation: string, details: string): Notification {
    return this.notify({
      title: "Approval Required",
      body: `Operation '${operation}' needs your approval: ${details}`,
      category: "approval_required",
      priority: "critical",
    });
  }

  /**
   * Convenience: notify about a compliance finding.
   */
  notifyComplianceAlert(
    framework: string,
    score: number,
    threshold: number,
  ): Notification {
    const priority: NotificationPriority = score < threshold ? "critical" : "normal";
    return this.notify({
      title: "Compliance Alert",
      body: `${framework}: score ${score.toFixed(1)}% (threshold: ${threshold}%)`,
      category: "compliance_alert",
      priority,
    });
  }

  /**
   * Convenience: notify about a new RFP detection.
   */
  notifyRfpDetected(filename: string, source: string): Notification {
    return this.notify({
      title: "New RFP Detected",
      body: `${filename} from ${source}`,
      category: "rfp_detected",
      priority: "high",
    });
  }

  /**
   * Convenience: notify about loop status changes.
   */
  notifyLoopStatus(
    phase: string,
    cycle: number,
    total: number,
  ): Notification {
    return this.notify({
      title: "Research Loop Update",
      body: `Phase: ${phase} | Cycle ${cycle}/${total}`,
      category: "loop_status",
      priority: "low",
    });
  }

  /**
   * Mark a notification as read.
   */
  markRead(id: string): boolean {
    const notification = this.notifications.find((n) => n.id === id);
    if (notification) {
      notification.read = true;
      return true;
    }
    return false;
  }

  /**
   * Mark all notifications as read.
   */
  markAllRead(): void {
    for (const n of this.notifications) {
      n.read = true;
    }
  }

  /**
   * Get notifications, optionally filtered.
   */
  getNotifications(params?: {
    category?: NotificationCategory;
    unreadOnly?: boolean;
    limit?: number;
    since?: number;
  }): Notification[] {
    let results = this.notifications;

    if (params?.category) {
      results = results.filter((n) => n.category === params.category);
    }
    if (params?.unreadOnly) {
      results = results.filter((n) => !n.read);
    }
    if (params?.since) {
      results = results.filter((n) => n.timestamp >= params.since!);
    }

    results = results.sort((a, b) => b.timestamp - a.timestamp);

    if (params?.limit) {
      results = results.slice(0, params.limit);
    }

    return results;
  }

  /**
   * Get unread notification count.
   */
  getUnreadCount(): number {
    return this.notifications.filter((n) => !n.read).length;
  }

  /**
   * Register a listener for new notifications.
   */
  addListener(id: string, callback: (notification: Notification) => void): void {
    this.listeners.set(id, callback);
  }

  /**
   * Remove a notification listener.
   */
  removeListener(id: string): void {
    this.listeners.delete(id);
  }

  /**
   * Update notifier configuration.
   */
  updateConfig(updates: Partial<NotifierConfig>): void {
    Object.assign(this.config, updates);
  }

  /**
   * Clear all notifications.
   */
  clear(): void {
    this.notifications = [];
  }

  private shouldShowSystem(notification: Notification): boolean {
    if (!this.config.enabled) return false;
    if (this.config.suppressedCategories.includes(notification.category)) return false;

    return (
      PRIORITY_ORDER[notification.priority] >=
      PRIORITY_ORDER[this.config.minSystemPriority]
    );
  }

  private sendSystemNotification(notification: Notification): void {
    // Electrobun system tray notification
    // In production, this calls the native notification API
    console.log(
      `[NOTIFICATION:${notification.priority.toUpperCase()}] ${notification.title}: ${notification.body}`,
    );
  }

  private trimNotifications(): void {
    if (this.notifications.length > this.config.maxRetained) {
      this.notifications = this.notifications.slice(-this.config.maxRetained);
    }
  }
}
