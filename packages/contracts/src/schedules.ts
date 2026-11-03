export interface ScheduleConfig {
 kind:'once'|'cron';timezone:string;atMs?:number;expression?:string;
 misfirePolicy:'skip'|'coalesce'|'bounded_catch_up';overlapPolicy:'skip'|'coalesce';maxCatchUp:number;expiresAtMs?:number;
}
export type ScheduleCommand=
 |{kind:'create';projectId:string;taskId:string;expectedTaskVersion:number;commandKey:string;config:ScheduleConfig}
 |{kind:'pause'|'cancel'|'resume';projectId:string;scheduleId:string;expectedVersion:number;commandKey:string}
 |{kind:'replace';projectId:string;scheduleId:string;expectedVersion:number;commandKey:string;config:ScheduleConfig};
export interface ScheduleView {
 scheduleId:string;projectId:string;taskId:string;version:number;state:'active'|'paused'|'cancelled'|'fulfilled';config:ScheduleConfig|null;requiresReplacement:boolean;nextFireAtMs:number|null;
}
export interface OccurrenceView {
 occurrenceId:string;scheduleId:string;version:number;scheduledAtMs:number;state:'pending'|'waiting_host'|'enqueued'|'skipped'|'cancelled';triggerId:string|null;deliveryState:string|null;
}
