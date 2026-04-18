import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

const fetcher = async (url: string, options?: RequestInit) => {
  const res = await fetch(url, options);
  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    throw new Error(error.message || `Request failed with status ${res.status}`);
  }
  return res.json();
};

export const useSummary = (opts: { liveOnly?: boolean } = {}) => {
  const qs = opts.liveOnly ? "?liveOnly=true" : "";
  return useQuery({
    queryKey: ["dashboard", "summary", { liveOnly: !!opts.liveOnly }],
    queryFn: () => fetcher(`/api/dashboard/summary${qs}`),
    refetchInterval: 30000,
  });
};

export const usePerformance = (opts: { liveOnly?: boolean } = {}) => {
  const qs = opts.liveOnly ? "?liveOnly=true" : "";
  return useQuery({
    queryKey: ["dashboard", "performance", { liveOnly: !!opts.liveOnly }],
    queryFn: () => fetcher(`/api/dashboard/performance${qs}`),
    refetchInterval: 60000,
  });
};

export const useBets = (page = 1, limit = 20, status = "all") => {
  return useQuery({
    queryKey: ["dashboard", "bets", { page, limit, status }],
    queryFn: () => fetcher(`/api/dashboard/bets?page=${page}&limit=${limit}&status=${status}&t=${Date.now()}`),
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    refetchInterval: 30000,
    retry: 3,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 10000),
  });
};

export const useBetsByLeague = () => {
  return useQuery({
    queryKey: ["dashboard", "bets", "by-league"],
    queryFn: () => fetcher("/api/dashboard/bets/by-league"),
    refetchInterval: 60000,
  });
};

export const useLeagueSoftness = (days = 30, minBets = 1) => {
  return useQuery({
    queryKey: ["dashboard", "league-softness", { days, minBets }],
    queryFn: () => fetcher(`/api/dashboard/league-softness?days=${days}&minBets=${minBets}`),
    refetchInterval: 120000,
  });
};

export const useBetsByMarket = () => {
  return useQuery({
    queryKey: ["dashboard", "bets", "by-market"],
    queryFn: () => fetcher("/api/dashboard/bets/by-market"),
    refetchInterval: 60000,
  });
};

export const useViability = () => {
  return useQuery({
    queryKey: ["dashboard", "viability"],
    queryFn: () => fetcher("/api/dashboard/viability"),
    refetchInterval: 120000,
  });
};

export const useNarratives = () => {
  return useQuery({
    queryKey: ["dashboard", "narratives"],
    queryFn: () => fetcher("/api/dashboard/narratives"),
    refetchInterval: 120000,
  });
};

export const useModel = () => {
  return useQuery({
    queryKey: ["dashboard", "model"],
    queryFn: () => fetcher("/api/dashboard/model"),
    refetchInterval: 120000,
  });
};

export const useComplianceLogs = (
  page = 1,
  limit = 20,
  actionType = "all",
  dateFrom?: string,
  dateTo?: string,
) => {
  const params = new URLSearchParams({ page: String(page), limit: String(limit), action_type: actionType });
  if (dateFrom) params.set("date_from", dateFrom);
  if (dateTo) params.set("date_to", dateTo);
  return useQuery({
    queryKey: ["compliance", "logs", { page, limit, actionType, dateFrom, dateTo }],
    queryFn: () => fetcher(`/api/compliance/logs?${params}`),
  });
};

export const useComplianceStats = () => {
  return useQuery({
    queryKey: ["compliance", "stats"],
    queryFn: () => fetcher("/api/compliance/stats"),
    refetchInterval: 30000,
  });
};

export const useApiBudget = () => {
  return useQuery({
    queryKey: ["dashboard", "api-budget"],
    queryFn: () => fetcher("/api/dashboard/api-budget"),
    refetchInterval: 300000,
  });
};

export const useOddspapiBudget = () => {
  return useQuery({
    queryKey: ["dashboard", "oddspapi-budget"],
    queryFn: () => fetcher("/api/dashboard/oddspapi-budget"),
    refetchInterval: 300000,
  });
};

export const useCommissionStats = () => {
  return useQuery({
    queryKey: ["dashboard", "commission"],
    queryFn: () => fetcher("/api/dashboard/commission"),
    refetchInterval: 120000,
  });
};

export const useTournamentStatus = () => {
  return useQuery({
    queryKey: ["dashboard", "tournament"],
    queryFn: () => fetcher("/api/dashboard/tournament"),
    refetchInterval: 300000,
  });
};

export const useClvStats = () => {
  return useQuery({
    queryKey: ["dashboard", "clv-stats"],
    queryFn: () => fetcher("/api/dashboard/clv-stats"),
    refetchInterval: 120000,
  });
};

export const useLeagueEdgeScores = () => {
  return useQuery({
    queryKey: ["leagues", "edge-scores"],
    queryFn: () => fetcher("/api/leagues/edge-scores"),
    refetchInterval: 5 * 60 * 1000,
  });
};

export const useScanStats = () => {
  return useQuery({
    queryKey: ["dashboard", "scan-stats"],
    queryFn: () => fetcher("/api/dashboard/scan-stats"),
    refetchInterval: 2 * 60 * 1000,
  });
};

export const useLineMovements = () => {
  return useQuery({
    queryKey: ["dashboard", "line-movements"],
    queryFn: () => fetcher("/api/dashboard/line-movements"),
    refetchInterval: 5 * 60 * 1000,
  });
};

export const useXGTeams = () => {
  return useQuery({
    queryKey: ["xg", "teams"],
    queryFn: () => fetcher("/api/xg/teams"),
    refetchInterval: 5 * 60 * 1000,
    retry: 2,
  });
};

export const useDiscoveredLeagues = () => {
  return useQuery({
    queryKey: ["leagues", "discovered"],
    queryFn: () => fetcher("/api/leagues/discovered"),
    refetchInterval: 5 * 60 * 1000,
  });
};

export const useLeagueDiscoveryStats = () => {
  return useQuery({
    queryKey: ["leagues", "discovery-stats"],
    queryFn: () => fetcher("/api/leagues/discovery-stats"),
    refetchInterval: 5 * 60 * 1000,
  });
};

export const useGoLiveReadiness = () => {
  return useQuery({
    queryKey: ["admin", "go-live-readiness"],
    queryFn: () => fetcher("/api/admin/go-live-readiness"),
    refetchInterval: 120000,
  });
};

export const useCoverage = () => {
  return useQuery({
    queryKey: ["admin", "coverage"],
    queryFn: () => fetcher("/api/admin/coverage"),
    refetchInterval: 120000,
  });
};

export const useExperiments = () => {
  return useQuery({
    queryKey: ["admin", "experiments"],
    queryFn: () => fetcher("/api/admin/experiments"),
    refetchInterval: 60000,
  });
};

export const useRunPromotionEngine = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      fetcher("/api/admin/run-promotion-engine", { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "experiments"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard", "bets"] });
    },
  });
};

export const useManualPromote = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { experiment_tag: string; target_tier: string; reason: string }) =>
      fetcher("/api/admin/promote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "experiments"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard", "bets"] });
    },
  });
};

export const useCircuitBreakerStatus = () => {
  return useQuery({
    queryKey: ["admin", "circuit-breaker"],
    queryFn: () => fetcher("/api/admin/circuit-breaker-status"),
    refetchInterval: 30000,
  });
};

export const useResumeAgent = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      fetcher("/api/admin/resume-agent", { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "circuit-breaker"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard", "summary"] });
    },
  });
};

export const useExecutionMetrics = () => {
  return useQuery({
    queryKey: ["dashboard", "execution-metrics"],
    queryFn: () => fetcher("/api/dashboard/execution-metrics"),
    refetchInterval: 60000,
  });
};

export const useInPlayBets = (opts: { liveOnly?: boolean } = {}) => {
  const qs = opts.liveOnly ? "?liveOnly=true" : "";
  return useQuery({
    queryKey: ["dashboard", "in-play", { liveOnly: !!opts.liveOnly }],
    queryFn: () => fetcher(`/api/dashboard/in-play${qs}`),
    refetchInterval: 30000,
  });
};

export const useUpcomingBets = (opts: { liveOnly?: boolean } = {}) => {
  const qs = opts.liveOnly ? "?liveOnly=true" : "";
  return useQuery({
    queryKey: ["dashboard", "upcoming-bets", { liveOnly: !!opts.liveOnly }],
    queryFn: () => fetcher(`/api/dashboard/upcoming-bets${qs}`),
    refetchInterval: 30000,
  });
};

export const useLiveSummary = () => {
  return useQuery({
    queryKey: ["dashboard", "live-summary"],
    queryFn: () => fetcher("/api/dashboard/live-summary"),
    refetchInterval: 30000,
  });
};

export const useAgentRecommendations = () => {
  return useQuery({
    queryKey: ["dashboard", "agent-recommendations"],
    queryFn: () => fetcher("/api/dashboard/agent-recommendations"),
    refetchInterval: 120000,
  });
};

export const useModelHealth = () => {
  return useQuery({
    queryKey: ["dashboard", "model-health"],
    queryFn: () => fetcher("/api/dashboard/model-health"),
    refetchInterval: 120000,
  });
};

export const useLiveTierStats = () => {
  return useQuery({
    queryKey: ["admin", "live-tier-stats"],
    queryFn: () => fetcher("/api/admin/live-tier-stats"),
    refetchInterval: 120000,
  });
};

export const useAlerts = (opts: { page?: number; limit?: number; severity?: string; acknowledged?: boolean } = {}) => {
  const { page = 1, limit = 50, severity, acknowledged } = opts;
  const params = new URLSearchParams();
  params.set("page", String(page));
  params.set("limit", String(limit));
  if (severity) params.set("severity", severity);
  if (acknowledged !== undefined) params.set("acknowledged", String(acknowledged));
  return useQuery({
    queryKey: ["alerts", { page, limit, severity, acknowledged }],
    queryFn: () => fetcher(`/api/alerts?${params.toString()}`),
    refetchInterval: 15000,
  });
};

export const useUnreadAlertCount = () => {
  return useQuery({
    queryKey: ["alerts", "unread-count"],
    queryFn: () => fetcher("/api/alerts/unread-count"),
    refetchInterval: 15000,
  });
};

export const useAcknowledgeAlert = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      fetcher(`/api/alerts/${id}/acknowledge`, { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["alerts"] });
    },
  });
};

export const useAcknowledgeAllAlerts = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => fetcher("/api/alerts/acknowledge-all", { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["alerts"] });
    },
  });
};

export const useFireTestAlert = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (severity: string) =>
      fetcher("/api/alerts/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ severity }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["alerts"] });
    },
  });
};

export const useRunAlertDetection = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => fetcher("/api/alerts/run-detection", { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["alerts"] });
    },
  });
};

export const useAgentControl = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (action: "start" | "pause" | "stop") =>
      fetcher("/api/agent/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["dashboard", "summary"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard", "bets"] });
      queryClient.invalidateQueries({ queryKey: ["compliance", "logs"] });
    },
  });
};

export const useLaunchPreflight = () => {
  return useQuery({
    queryKey: ["launch", "preflight"],
    queryFn: () => fetcher("/api/launch-activation/preflight"),
    staleTime: 10000,
  });
};

export const useLaunchActivation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => fetcher("/api/launch-activation", { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["dashboard", "summary"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard", "bets"] });
    },
  });
};
