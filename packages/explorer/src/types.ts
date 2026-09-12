// The SchemaGraph contract is generated from packages/contract/schema-graph.v1.json into
// ./contract.generated.ts and re-exported here, so every view keeps importing it from './types'.
// Regenerate with `npm run contract`; `npm run contract:check` fails on drift.
export type {ColumnProfiling, SchemaCheck, SchemaColumn, SchemaGraph, SchemaIndex, SchemaLink, SchemaProject, SchemaSource, SchemaTable, TableProfiling} from './contract.generated';
import type {SchemaGraph} from './contract.generated';
// Hand-written host and live-connection types: the artifact's runtime surface, not the exchange
// format, so they stay out of the generated contract.
export interface SubtreeResult {nodes:{id:string;tableId:string;depth:number;rowCount:number;truncated?:boolean}[];links:{source:string;target:string;ratio:number|null;count?:number;truncated?:boolean}[];truncated:boolean;limit:number;[key:string]:unknown}
export interface ProfileResult {graph:SchemaGraph;sampled:boolean;limit:number}
export interface LiveConnection {profile?:(request:{tables:string[];maxRowsPerTable:number},signal?:AbortSignal)=>Promise<ProfileResult>;subtree?:(request:{rootTable:string;pkValue:unknown;depth:number;maxRowsPerHop:number},signal?:AbortSignal)=>Promise<SubtreeResult>}
// Drill-through contract (C03, F14, ADR-0004 decision 2): the eight fields below are additive and
// optional, and `onSelectTable` is unchanged, so the nine views compile untouched until W04 wires
// them. Absence of a callback means the view does not offer that action, which is the existing
// `onSelectTables ? onSelectTables(ids) : onSelectTable(ids[0])` idiom.
export type {NavigationTarget, Selection, ViewId} from './selection';
import type {NavigationTarget, Selection} from './selection';
export interface ViewProps {
  /** The filtered graph. Its `links` array stays whole, so endpoints can be absent. */
  graph:SchemaGraph;
  onSelectTable:(id:string)=>void;
  onSelectTables?:(ids:string[])=>void;
  live?:LiveConnection;
  /** Inbound selection, owned by the shell. */
  selected?:Selection;
  onSelectColumn?:(columnId:string)=>void;
  onSelectRelationship?:(relationshipRef:string)=>void;
  onNavigate?:(target:NavigationTarget)=>void;
  /** The view's `v.*` slice, parsed from the URL by `route-state.ts`. */
  viewState?:Record<string,string>;
  onViewStateChange?:(patch:Record<string,string|undefined>)=>void;
  /** The unfiltered graph, for "show related" and for dimming. */
  fullGraph?:SchemaGraph;
  /** The theme the shell has decided on; replaces per-view DOM detection. */
  theme?:'light'|'dark';
}
