import type {MainResourceSample} from '../../contracts/src/budget.ts';
interface Counters {user:number;system:number;rssBytes:number}
export interface MainSamplerOptions {/** Trusted unit tests only. No IPC accepts a sampler or clock. */read?:()=>Counters;monotonic?:()=>number;wallClock?:()=>number}
/** Samples only this Main process. CPU=one core at 100%; children and tools are outside its scope. */
export class MainResourceSampler {
  private options:MainSamplerOptions;private previous?:{at:number;user:number;system:number};private cached?:MainResourceSample;
  constructor(options:MainSamplerOptions={}){this.options=options;}
  sample():MainResourceSample{
    const at=(this.options.monotonic??(()=>performance.now()))();
    if(this.cached&&this.previous&&at>=this.previous.at&&at-this.previous.at<1000)return{...this.cached};
    const observedAt=(this.options.wallClock??Date.now)(),values=this.options.read?.()??{...process.cpuUsage(),rssBytes:process.memoryUsage.rss()};
    if(!Number.isSafeInteger(observedAt)||observedAt<1||!Number.isSafeInteger(values.rssBytes)||values.rssBytes<1)throw Error('RESOURCE_SAMPLE_INVALID');
    const valid=Number.isFinite(at)&&at>=0&&Number.isSafeInteger(values.user)&&values.user>=0&&Number.isSafeInteger(values.system)&&values.system>=0;
    let cpuPercent:number|null=null;
    if(valid&&this.previous&&at>this.previous.at&&at-this.previous.at<=10000&&values.user>=this.previous.user&&values.system>=this.previous.system){
      const percent=((values.user-this.previous.user)+(values.system-this.previous.system))/((at-this.previous.at)*1000)*100;if(Number.isFinite(percent))cpuPercent=Math.round(percent*100)/100;
    }
    this.previous=valid?{at,user:values.user,system:values.system}:undefined;
    this.cached={observedAt,rssBytes:values.rssBytes,cpuPercent,scope:'main_process',basis:'one_core_100_percent'};return{...this.cached};
  }
}
