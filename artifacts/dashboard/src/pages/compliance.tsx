import { useState } from "react";
import { useComplianceLogs } from "@/hooks/use-dashboard";
import { formatDate } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Download, ChevronLeft, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export default function Compliance() {
  const [page, setPage] = useState(1);
  const [actionType, setActionType] = useState("all");

  const { data: logsData, isLoading } = useComplianceLogs(page, 20, actionType);

  const handleExport = () => {
    window.location.href = "/api/compliance/export?format=csv";
  };

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h2 className="text-3xl font-bold tracking-tight">Compliance & Audit</h2>
          <p className="text-muted-foreground">Immutable logs of agent actions, system states, and manual interventions.</p>
        </div>
        <Button onClick={handleExport} variant="outline" className="shrink-0 gap-2" data-testid="btn-export-csv">
          <Download className="w-4 h-4" />
          Export CSV
        </Button>
      </div>

      <Card className="flex flex-col min-h-[600px]">
        <div className="p-4 border-b border-border flex items-center justify-between bg-card/50">
          <Select value={actionType} onValueChange={(v) => { setActionType(v); setPage(1); }}>
            <SelectTrigger className="w-[200px]" data-testid="select-log-type">
              <SelectValue placeholder="Filter by action" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Actions</SelectItem>
              <SelectItem value="SYSTEM_START">System Start</SelectItem>
              <SelectItem value="SYSTEM_STOP">System Stop</SelectItem>
              <SelectItem value="BET_PLACED">Bet Placed</SelectItem>
              <SelectItem value="BET_SETTLED">Bet Settled</SelectItem>
              <SelectItem value="CONFIG_CHANGE">Config Change</SelectItem>
              <SelectItem value="ERROR">Errors</SelectItem>
            </SelectContent>
          </Select>

          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>Page {logsData?.page || 1} of {logsData?.totalPages || 1}</span>
            <div className="flex gap-1">
              <Button 
                variant="outline" 
                size="icon" 
                className="h-8 w-8"
                disabled={page <= 1}
                onClick={() => setPage(p => p - 1)}
                data-testid="btn-prev-logs"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button 
                variant="outline" 
                size="icon" 
                className="h-8 w-8"
                disabled={page >= (logsData?.totalPages || 1)}
                onClick={() => setPage(p => p + 1)}
                data-testid="btn-next-logs"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
        
        <CardContent className="flex-1 p-0">
          {isLoading ? (
            <div className="p-6 space-y-4">
              {[...Array(10)].map((_, i) => (
                <div key={i} className="h-12 bg-secondary rounded animate-pulse" />
              ))}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[180px]">Timestamp</TableHead>
                  <TableHead className="w-[150px]">Action Type</TableHead>
                  <TableHead>Details</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logsData?.logs?.map((log: any) => (
                  <TableRow key={log.id}>
                    <TableCell className="font-mono text-xs text-muted-foreground whitespace-nowrap">
                      {formatDate(log.timestamp)}
                    </TableCell>
                    <TableCell>
                      <LogTypeBadge type={log.actionType} />
                    </TableCell>
                    <TableCell className="font-mono text-xs break-all">
                      {log.details}
                    </TableCell>
                  </TableRow>
                ))}
                {logsData?.logs?.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center py-8 text-muted-foreground">
                      No logs found for the selected filter.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function LogTypeBadge({ type }: { type: string }) {
  if (type === 'ERROR') return <Badge variant="outline" className="text-red-500 border-red-500/30 font-mono text-[10px]">{type}</Badge>;
  if (type.includes('START') || type.includes('STOP')) return <Badge variant="outline" className="text-amber-500 border-amber-500/30 font-mono text-[10px]">{type}</Badge>;
  if (type.includes('BET')) return <Badge variant="outline" className="text-primary border-primary/30 font-mono text-[10px]">{type}</Badge>;
  return <Badge variant="outline" className="font-mono text-[10px]">{type}</Badge>;
}
