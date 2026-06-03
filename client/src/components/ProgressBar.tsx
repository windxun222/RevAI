interface PBProps { progress: number; }
export function ProgressBar({ progress }: PBProps) { return (<div className="w-full bg-gray-800 rounded-full h-1.5 overflow-hidden"><div className="h-full bg-gradient-to-r from-indigo-500 to-purple-500 rounded-full transition-all duration-700 ease-out" style={{width:`${Math.min(100,Math.max(0,progress))}%`}}/></div>); }
