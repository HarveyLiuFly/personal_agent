import type {TaskStatus} from '../../../docs/design/contracts/domain.ts';
import type {CodeTaskSpec} from './views.ts';
export interface TaskSummary {
 projectId:string;taskId:string;title:string;status:TaskStatus;version:number;blocked:boolean;
 activeRunId:string|null;mode:'readOnly'|'workspaceWrite';updatedAt:number;
}
export type TaskCommand =
 | {projectId:string;commandKey:string;kind:'create';text:string;code?:CodeTaskSpec}
 | {projectId:string;commandKey:string;kind:'pause'|'cancel'|'resume';taskId:string;expectedVersion:number}
 | {projectId:string;commandKey:string;kind:'rename';taskId:string;expectedVersion:number;title:string};
export interface OperationReceipt {
 operationId:string;kind:string;state:'executing'|'completed'|'outcome_unknown';taskId:string;
 taskVersion:number;status:TaskStatus;blocked:boolean;runId:string|null;
}
export interface ActivityItem {sequence:number;eventId:string;taskId:string;eventType:string;taskVersion:number;runId:string|null}
export interface ActivityPage {items:ActivityItem[];nextCursor:number|null}
