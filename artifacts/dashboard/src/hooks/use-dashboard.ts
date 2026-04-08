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

export const useComplianceLogs = (page = 1, limit = 20, actionType = "all") => {
  return useQuery({
    queryKey: ["compliance", "logs", { page, limit, actionType }],
    queryFn: () => fetcher(`/api/compliance/logs?page=${page}&limit=${limit}&action_type=${actionType}`),
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
