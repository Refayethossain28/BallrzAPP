/**
 * Agency rollup — the agent tier. A letting agent manages several client
 * landlords; this aggregates each client's portfolio health (properties,
 * certificates needing action, rent arrears) into one book-of-business view.
 * Pure and tested; the per-client snapshots are computed in the app from each
 * landlord's data using the compliance + rent engines, then rolled up here.
 *
 * Money is integer **pence** (GBP).
 */

export interface AgencyClientSnapshot {
  landlordId: string;
  landlordName: string;
  properties: number;
  /** Certificates that are expiring soon or missing/expired (attention + breach). */
  certsToAction: number;
  arrearsPence: number;
}

export interface AgencyRollup {
  clients: AgencyClientSnapshot[];
  clientCount: number;
  totalProperties: number;
  totalCertsToAction: number;
  totalArrearsPence: number;
}

/**
 * Roll client snapshots into an agency total, ordered worst-first (most arrears,
 * then most certificates to action) so the agent sees what needs chasing on top.
 */
export function rollupAgency(clients: AgencyClientSnapshot[]): AgencyRollup {
  const sorted = [...clients].sort(
    (a, b) => b.arrearsPence - a.arrearsPence || b.certsToAction - a.certsToAction,
  );
  return {
    clients: sorted,
    clientCount: clients.length,
    totalProperties: clients.reduce((s, c) => s + c.properties, 0),
    totalCertsToAction: clients.reduce((s, c) => s + c.certsToAction, 0),
    totalArrearsPence: clients.reduce((s, c) => s + c.arrearsPence, 0),
  };
}

/** Seats included with the agent plan; extra seats bill per the billing module. */
export const AGENT_INCLUDED_SEATS = 3;

/** Whether an agency with `memberCount` members is within its seat allowance. */
export function withinSeatAllowance(memberCount: number, includedSeats: number = AGENT_INCLUDED_SEATS): boolean {
  return memberCount <= includedSeats;
}
