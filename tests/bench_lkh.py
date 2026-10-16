# pip install elkai   (LKH). Usage: python3 bench_lkh.py bench_lkh.json  -- adds the near-optimal "lkh" length to each row
import json,sys,math,elkai
rows=json.load(open(sys.argv[1]))
import collections
agg=collections.defaultdict(list)
for r in rows:
    n=r['n'];p=r['points'];xy=[(p[2*i],p[2*i+1]) for i in range(n)]
    S=1000
    m=elkai.DistanceMatrix([[int(round(math.dist(a,b)*S)) for b in xy] for a in xy])
    t=m.solve_tsp(runs=3)
    L=sum(math.dist(xy[t[i]],xy[t[(i+1)%n]]) for i in range(n))
    r['lkh']=L; agg[n].append((r['ours']/L-1)*100)
    print(n,r['seed'],'ours %.1f lkh %.1f gap %.2f%%'%(r['ours'],L,(r['ours']/L-1)*100),flush=True)
for n,v in agg.items(): print('n=%d mean gap to LKH %.2f%%'%(n,sum(v)/len(v)))
json.dump(rows,open(sys.argv[1],'w'))
