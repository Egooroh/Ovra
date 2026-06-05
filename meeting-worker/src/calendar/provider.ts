// Unified interface all calendar backends implement.
// The watcher only depends on this — providers are swappable.

export interface CalendarEvent {
  /** Globally unique, stable across polls. Format: "<provider>:<eventId>". */
  id: string;
  title: string;
  startAt: Date;
  endAt: Date | null;
  /** Already-extracted Telemost join URL from the event body/location. */
  joinUrl: string;
}

export interface CalendarProvider {
  /** Human-readable name used in logs ("google", "yandex"). */
  readonly name: string;
  /** Return events with a Telemost link whose start time falls in [from, to]. */
  fetchEvents(from: Date, to: Date): Promise<CalendarEvent[]>;
}
