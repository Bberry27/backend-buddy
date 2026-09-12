import React,{useMemo,useState} from 'react';
import {createRoot,Root} from 'react-dom/client';
import Fanout from './Fanout';
import ColumnTable from './ColumnTable';
import City from './City';
import LivingERD from './LivingERD';
import NormalizationLens from './NormalizationLens';
import Domains from './Domains';
import JoinMatrix from './JoinMatrix';
import ArcDiagram from './ArcDiagram';
import SchemaDiff from './SchemaDiff';
import {computeCommunities} from './lens-domain-logic';
import {decideMount} from './mount-policy';
import type {ViewProps} from './types';

let root:Root|undefined;
// What the root currently holds. `mount-policy.ts` decides what to do with it, and carries the
// RK-05 note on the lifecycle assumptions root reuse changes (City selection, Schema Diff state).
let mounted:{container:HTMLElement;view:string}|undefined;
let mounts=0;
function CityDistricts(props:ViewProps){
  const [mode,setMode]=useState('business');
  const graph=useMemo(()=>{if(mode==='business')return props.graph;const communities=computeCommunities(props.graph);const ordered=[...new Set(communities.values())].sort();return {...props.graph,tables:props.graph.tables.map(t=>({...t,domain:'D'+String(ordered.indexOf(communities.get(t.id)!)+1).padStart(2,'0')}))};},[props.graph,mode]);
  return <div style={{height:'100%',minHeight:0,display:'grid',gridTemplateRows:'auto minmax(0,1fr)'}}><label style={{display:'flex',alignItems:'center',gap:10,padding:'6px 12px'}}>Districts<select aria-label="City district grouping" value={mode} onChange={e=>setMode(e.target.value)} style={{width:200}}><option value="business">Business domains</option><option value="discovered">Discovered FK communities</option></select></label><City {...props} graph={graph}/></div>;
}
/** Roots created since the bundle loaded. Constant across filter keystrokes (CTQ-10). */
export function mountCount(){return mounts;}
export function unmount(){root?.unmount();root=undefined;mounted=undefined;}
export function mount(container:HTMLElement,view:string,props:ViewProps){
  const decision=decideMount(mounted,{container,view});
  if(decision==='recreate')unmount();
  if(decision!=='update'||!root){root=createRoot(container);mounts++;}
  mounted={container,view};
  const Component=({fanout:Fanout,columns:ColumnTable,city:CityDistricts,living:LivingERD,lens:NormalizationLens,domains:Domains,matrix:JoinMatrix,arcs:ArcDiagram,diff:SchemaDiff} as Record<string,React.ComponentType<ViewProps>>)[view];
  root.render(Component?<Component {...props}/>:<p>View unavailable</p>);
}
