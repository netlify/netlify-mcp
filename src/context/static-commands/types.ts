export interface StaticCommand {
  operationId: string;
  commandText: string;
  runRequiresParams?: boolean;
  runOperation?: (params?: Record<string, any>) => Promise<any>
}
