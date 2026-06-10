import * as vscode from 'vscode';
import { formatCost } from '../core/aggregate';
import { UsageState } from '../store';
import { UsageStore } from '../store';

const FIRED_KEY = 'claudometer.alertsFired';

/**
 * Notification subscriber: quota thresholds (with an opt-in "tell me when the
 * window resets" follow-up) and monthly budget thresholds. Each alert fires
 * once per window/month — the fired set is persisted so restarts don't
 * re-toast, and pruned so it can't grow unbounded.
 */
export class Alerts implements vscode.Disposable {
  private readonly subscription: vscode.Disposable;
  private fired: Set<string>;
  private readonly resetTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly memento: vscode.Memento,
    store: UsageStore
  ) {
    this.fired = new Set(memento.get<string[]>(FIRED_KEY, []));
    this.subscription = store.onDidChange((state) => this.check(state));
  }

  private enabled(): boolean {
    return vscode.workspace.getConfiguration('claudometer').get<boolean>('alerts.enabled', true);
  }

  private check(state: UsageState): void {
    if (!this.enabled()) return;

    const q = state.quota;
    if (q) {
      this.checkQuota('5-hour', q.fiveHourUtilization, q.fiveHourResetAtMs, 'q5');
      this.checkQuota('weekly', q.sevenDayUtilization, q.sevenDayResetAtMs, 'q7');
    }

    const budget = vscode.workspace
      .getConfiguration('claudometer')
      .get<number>('budget.monthly', 0);
    if (budget > 0 && state.summary) {
      const spent = state.summary.monthCost;
      const month = new Date().toISOString().slice(0, 7);
      for (const threshold of [0.8, 1.0]) {
        if (spent >= budget * threshold) {
          this.fireOnce(`b|${month}|${threshold}`, () => {
            void vscode.window.showWarningMessage(
              `Claudometer: ${Math.round((spent / budget) * 100)}% of your ${formatCost(budget)} monthly budget used (${formatCost(spent)}).`
            );
          });
        }
      }
    }
  }

  private checkQuota(label: string, utilization: number, resetAtMs: number, prefix: string): void {
    for (const threshold of [0.8, 0.95]) {
      if (utilization < threshold) continue;
      this.fireOnce(`${prefix}|${resetAtMs}|${threshold}`, () => {
        void vscode.window
          .showWarningMessage(
            `Claudometer: ${Math.round(utilization * 100)}% of your ${label} quota used — resets ${timeUntil(resetAtMs)}.`,
            'Notify me at reset'
          )
          .then((choice) => {
            if (choice) this.scheduleResetNotice(label, resetAtMs);
          });
      });
    }
  }

  private scheduleResetNotice(label: string, resetAtMs: number): void {
    const key = `${label}|${resetAtMs}`;
    if (this.resetTimers.has(key)) return;
    const delay = resetAtMs - Date.now() + 30_000;
    if (delay <= 0) return;
    this.resetTimers.set(
      key,
      setTimeout(() => {
        this.resetTimers.delete(key);
        void vscode.window.showInformationMessage(
          `Claudometer: your ${label} quota window has reset — you're good to go.`
        );
      }, delay)
    );
  }

  private fireOnce(key: string, fn: () => void): void {
    if (this.fired.has(key)) return;
    this.fired.add(key);
    // Prune: quota keys embed their reset time; drop the expired ones.
    const now = Date.now();
    this.fired = new Set(
      [...this.fired].filter((k) => {
        const parts = k.split('|');
        if (parts[0] === 'q5' || parts[0] === 'q7') return Number(parts[1]) > now - 86_400_000;
        return true;
      })
    );
    if (this.fired.size > 100) this.fired = new Set([...this.fired].slice(-100));
    void this.memento.update(FIRED_KEY, [...this.fired]);
    fn();
  }

  dispose(): void {
    this.subscription.dispose();
    for (const timer of this.resetTimers.values()) clearTimeout(timer);
    this.resetTimers.clear();
  }
}

function timeUntil(ms: number): string {
  const diff = ms - Date.now();
  if (diff <= 0) return 'soon';
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  if (h >= 24) return `in ${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `in ${h}h ${m}m`;
  return `in ${m}m`;
}
