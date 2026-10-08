import type { FC } from "hono/jsx";
import type { BranchRow, MergeRow } from "./db.js";

export interface DashboardProps {
  branches: BranchRow[];
  merges: MergeRow[];
}

function safeTouches(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

const CSS = `
  body { font-family: system-ui, sans-serif; margin: 2rem; color: #1a1a1a; }
  h1 { font-size: 1.6rem; }
  h2 { margin-top: 2rem; font-size: 1.2rem; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #ccc; padding: 0.4rem 0.6rem; text-align: left; font-size: 0.85rem; vertical-align: top; }
  th { background: #f5f5f5; }
  code { font-size: 0.8rem; background: #f5f5f5; padding: 0.1rem 0.3rem; border-radius: 3px; }
  .pill { display: inline-block; padding: 0.1rem 0.5rem; border-radius: 999px; font-size: 0.75rem; font-weight: 600; }
  .open { background: #e3f2fd; } .merged { background: #e8f5e9; }
  .needs-resolution { background: #fff3e0; } .failed { background: #ffebee; }
  .queued { background: #f3e5f5; }
  .empty { color: #777; font-style: italic; }
`;

/** Single server-rendered page. No client JS. */
export const Dashboard: FC<DashboardProps> = (props) => {
  const { branches, merges } = props;
  return (
    <html>
      <head>
        <title>Branchline</title>
        <style>{CSS}</style>
      </head>
      <body>
        <h1>Branchline</h1>
        <h2>Branches</h2>
        {branches.length === 0 ? (
          <p className="empty">No branches yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Agent</th>
                <th>Intent</th>
                <th>Touches</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {branches.map((b) => (
                <tr key={b.name}>
                  <td>
                    <code>{b.name}</code>
                  </td>
                  <td>{b.agent_id}</td>
                  <td>{b.intent}</td>
                  <td>
                    {safeTouches(b.touches).map((t) => (
                      <code key={t}>{t}</code>
                    ))}
                  </td>
                  <td>
                    <span className={`pill ${b.status}`}>{b.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <h2>Merge queue</h2>
        {merges.length === 0 ? (
          <p className="empty">No merge jobs yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Branch</th>
                <th>Target</th>
                <th>Tier</th>
                <th>Status</th>
                <th>Merge SHA</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {merges.map((m) => (
                <tr key={m.id}>
                  <td>{m.id}</td>
                  <td>
                    <code>{m.branch}</code>
                  </td>
                  <td>{m.target}</td>
                  <td>{m.tier ?? "—"}</td>
                  <td>
                    <span className={`pill ${m.status}`}>{m.status}</span>
                  </td>
                  <td>
                    {m.merge_sha ? <code>{m.merge_sha.slice(0, 8)}</code> : "—"}
                  </td>
                  <td>{m.created_at}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </body>
    </html>
  );
};

/** Render the dashboard to an HTML string (used from plain .ts modules). */
export async function renderDashboard(props: DashboardProps): Promise<string> {
  const rendered = Dashboard(props);
  const resolved = rendered instanceof Promise ? await rendered : rendered;
  if (resolved == null) return "";
  const s = resolved.toString();
  return s instanceof Promise ? await s : s;
}
