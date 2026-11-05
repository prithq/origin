import { Link, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { OverviewPage } from "./pages/OverviewPage";
import { DiscoveryPage } from "./pages/DiscoveryPage";
import { OpportunitiesPage } from "./pages/OpportunitiesPage";
import { OpportunityPage } from "./pages/OpportunityPage";
import { CouncilPage } from "./pages/CouncilPage";
import { ActivityPage } from "./pages/ActivityPage";
import { BuildStudioPage } from "./pages/BuildStudioPage";

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<OverviewPage />} />
        <Route path="/discovery" element={<DiscoveryPage />} />
        <Route path="/opportunities" element={<OpportunitiesPage />} />
        <Route path="/opportunities/:id" element={<OpportunityPage />} />
        <Route path="/council" element={<CouncilPage />} />
        <Route path="/activity" element={<ActivityPage />} />
        <Route path="/build" element={<BuildStudioPage />} />
        <Route path="/build/:id" element={<BuildStudioPage />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}

function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <p className="text-sm font-medium text-content">Page not found</p>
      <p className="mt-1.5 text-xs text-muted">
        That route does not exist in Origin.
      </p>
      <Link
        to="/"
        className="mt-4 rounded border border-border bg-surface px-3 py-1.5 text-xs text-content transition-colors hover:bg-surface-hover"
      >
        Back to Overview
      </Link>
    </div>
  );
}
