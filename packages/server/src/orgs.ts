import type { Role } from './types.js';

/**
 * Who can run a BharatPulse workspace. Governments and private operators use the same engine, graph and languages;
 * what changes is the vocabulary (ward / plant block / road stretch), the job titles of the four levels, who reports
 * (residents, customers, road users, staff) and the plan they buy.
 */
export type OrgType = 'municipality' | 'water_utility' | 'toll_road' | 'industrial_park' | 'campus';
export type Sector = 'government' | 'private';

export interface OrgTypeInfo {
  id: OrgType;
  sector: Sector;
  label: string;
  /** what one area is called */
  area: string;
  /** who files reports */
  reporters: string;
  /** job titles for L1..L4 */
  titles: Record<Exclude<Role, 'CITIZEN'>, string>;
  office: string;
}

export const ORG_TYPES: OrgTypeInfo[] = [
  { id: 'municipality', sector: 'government', label: 'Municipality / Nagar Palika', area: 'Ward', reporters: 'Residents', office: 'Nagar Palika Parishad', titles: { L1: 'Field Officer', L2: 'Zonal Officer', L3: 'Department Head', L4: 'Commissioner' } },
  { id: 'water_utility', sector: 'private', label: 'Water utility (PPP / private)', area: 'Service zone', reporters: 'Customers', office: 'Utility operations', titles: { L1: 'Field Technician', L2: 'Zone Supervisor', L3: 'Operations Head', L4: 'Managing Director' } },
  { id: 'toll_road', sector: 'private', label: 'Highway / toll road operator', area: 'Stretch', reporters: 'Road users', office: 'Highway operations', titles: { L1: 'Patrol Engineer', L2: 'Section Supervisor', L3: 'Project Manager', L4: 'Project Director' } },
  { id: 'industrial_park', sector: 'private', label: 'Industrial park / SEZ', area: 'Block', reporters: 'Units and staff', office: 'Estate management', titles: { L1: 'Maintenance Technician', L2: 'Block Supervisor', L3: 'Estate Manager', L4: 'Park CEO' } },
  { id: 'campus', sector: 'private', label: 'Campus / hospital', area: 'Block', reporters: 'Students and staff', office: 'Facilities office', titles: { L1: 'Facilities Technician', L2: 'Facilities Supervisor', L3: 'Facilities Head', L4: 'Registrar' } },
];

export const orgType = (id: unknown): OrgTypeInfo => ORG_TYPES.find((o) => o.id === id) ?? ORG_TYPES[0];

/**
 * A private site whose water comes from a government network. With the operator's consent, a confirmed outage at the
 * site is referred to the government workspace at the asset that feeds it: in the graph, the city's pipe FEEDS the
 * site's tank across the two workspaces. Only the referral (what, where, how many people) crosses; never the reports.
 */
export interface Partner { tenant: string; asset: string; inlet: { lat: number; lng: number }; consent: true; since: number }

export interface Referral {
  id: string;
  from: string; fromName: string;
  to: string; toName: string;
  asset: string; assetName: string;
  incidentId: string;
  what: string;
  reports: number;
  people: number;
  at: number;
  status: 'open' | 'acknowledged';
}
