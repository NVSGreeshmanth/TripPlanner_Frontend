// Official TfNSW line colours — pure lookup, no dependencies. Given a mode-of-
// transport class + line name, returns { bg, fg } hex colours for the line badge.
export function getLineColors(mot, nm) {
  const n = (nm || '').toUpperCase();
  const c = {
    'T1':{ bg:'#F99D1C', fg:'#000' }, 'T2':{ bg:'#0098CD', fg:'#fff' },
    'T3':{ bg:'#F37021', fg:'#fff' }, 'T4':{ bg:'#005AA3', fg:'#fff' },
    'T5':{ bg:'#C4258F', fg:'#fff' }, 'T7':{ bg:'#A1BA0A', fg:'#fff' },
    'T8':{ bg:'#009B77', fg:'#fff' }, 'T9':{ bg:'#D11F2F', fg:'#fff' },
    'M1':{ bg:'#009599', fg:'#fff' }, 'BMT':{ bg:'#F99D1C', fg:'#000' },
    'CCN':{ bg:'#D11F2F', fg:'#fff' }, 'SCO':{ bg:'#005AA3', fg:'#fff' },
    'HUN':{ bg:'#833134', fg:'#fff' }, 'SHL':{ bg:'#833134', fg:'#fff' },
    'L1':{ bg:'#E31837', fg:'#fff' }, 'L2':{ bg:'#E31837', fg:'#fff' },
    'L3':{ bg:'#E31837', fg:'#fff' }
  };
  if (c[n]) return c[n];
  const b = { 1:'#F99D1C', 2:'#009599', 4:'#E31837', 5:'#00B5EF', 7:'#7B4F9E', 9:'#00A54F', 11:'#FFD700' };
  const f = { 1:'#000',    2:'#fff',    4:'#fff',    5:'#fff',    7:'#fff',   9:'#fff',    11:'#000'   };
  return { bg: b[mot] || '#666', fg: f[mot] || '#fff' };
}
