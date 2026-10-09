import { Dashboard } from "@/components/Dashboard";
import { parseFilters } from "@/lib/filters";
import { fetchHealth, fetchSnapshot, receiverUrl } from "@/lib/receiver";

export const dynamic = "force-dynamic";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [snapshot, health, params] = await Promise.all([fetchSnapshot(), fetchHealth(), searchParams]);
  return (
    <Dashboard
      initialSnapshot={snapshot}
      initialHealth={health}
      initialFilters={parseFilters(params)}
      receiverUrl={receiverUrl()}
      serverNow={snapshot?.now ?? new Date().toISOString()}
    />
  );
}
