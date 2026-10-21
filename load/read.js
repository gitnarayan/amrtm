import http from 'k6/http';
import {check} from 'k6';
export const options={scenarios:{reads:{executor:'constant-arrival-rate',rate:Number(__ENV.RATE||100),timeUnit:'1s',duration:__ENV.DURATION||'5m',preAllocatedVUs:50,maxVUs:500}},thresholds:{http_req_duration:['p(95)<200'],http_req_failed:['rate<0.0005'],checks:['rate>0.9995']}};
export default function(){const r=http.get(`${__ENV.BASE_URL}/v1/doctors?limit=25`,{headers:{Authorization:`Bearer ${__ENV.ACCESS_TOKEN}`}});check(r,{'read succeeded':r=>r.status===200});}
