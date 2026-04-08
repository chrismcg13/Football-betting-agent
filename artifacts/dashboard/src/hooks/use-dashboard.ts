import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

const fetcher = async (url: string, options?: RequestInit) => {
  const res = await fetch(url, options);
  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    throw new Error(error.message || `Request failed with status ${res.status}`);
  }
  return res.json();
};

export const useSummary = () => {
  return useQuery({
    queryKey: ["dashboard", "summary"],
    queryFn: () => fetcher("/api/dashboard/summary"),
    refetchInterval: 60000,
  });
};

export const usePerformance = () => {
  return useQuery({
    queryKey: ["dashboard", "performance"],
    queryFn: () => fetcher("/api/dashboard/performance"),
  });
};

export const useBets = (page = 1, limit = 20, status = "all") => {
  return useQuery({
    queryKey: ["dashboard", "bets", { page, limit, status }],
    queryFn: () => fetcher(`/api/dashboard/bets?page=${page}&limit=${limit}&status=${status}`),
  });
};

export const useBetsByLeague = () => {
  return useQuery({
    queryKey: ["dashboard", "bets", "by-league"],
    queryFn: () => fetcher("/api/dashboard/bets/by-league"),
  });
};

export const useBetsByMarket = () => {
  return useQuery({
    queryKey: ["dashboard", "bets", "by-market"],
    queryFn: () => fetcher("/api/dashboard/bets/by-market"),
  });
};

export const useViability = () => {
  return useQuery({
    queryKey: ["dashboard", "viability"],
    queryFn: () => fetcher("/api/dashboard/viability"),
  });
};

export const useNarratives = () => {
  return useQuery({
    queryKey: ["dashboard", "narratives"],
    queryFn: () => fetcher("/api/dashboard/narratives"),
  });
};

export const useModel = () => {
  return useQuery({
    queryKey: ["dashboard", "model"],
    queryFn: () => fetcher("/api/dashboard/model"),
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

export const useClvStats = () => {
  return useQuery({
    queryKey: ["dashboard", "clv-stats"],
    queryFn: () => fetcher("/api/dashboard/clv-stats"),
    refetchInterval: 120000,
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
      queryClient.invalidateQueries({ queryKey: ["compliance", "logs"] });
    },
  });
};
