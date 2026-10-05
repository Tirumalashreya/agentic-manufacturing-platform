// Each type mirrors one domain tools file's *_HEADERS constant exactly —
// Domestic Sales = SalesOrders, Export = ExportOrders, Trading =
// TradingOrders, etc. (see PLAN.md). These are the full-history shapes
// (list_sales_orders(), not list_credit_blocked_orders()), distinct from
// the narrower ActiveWorkflowItem used on the Active Workflows queue.

export type SalesOrder = {
  sales_order_id: string;
  customer_id: string | null;
  customer_name: string | null;
  product_id: string | null;
  product_name: string | null;
  quantity: number | null;
  unit_price: number | null;
  total_amount: number | null;
  requested_deadline: string | null;
  status: string;
  created_at: string;
};

export type Invoice = {
  invoice_id: string;
  sales_order_id: string | null;
  delivery_id: string | null;
  customer_id: string | null;
  customer_name: string | null;
  quantity_billed: number;
  unit_price: number;
  invoice_amount: number;
  payment_terms_days: number;
  due_date: string;
  status: "ISSUED" | "PAID";
  notes: string | null;
  created_at: string;
};

export type ExportOrder = {
  export_order_id: string;
  customer_id: string | null;
  customer_name: string | null;
  product_id: string | null;
  product_name: string | null;
  quantity: number | null;
  unit_price: number | null;
  total_value: number | null;
  destination_country: string | null;
  incoterm: string | null;
  proforma_invoice_id: string | null;
  payment_reference: string | null;
  customs_declaration_no: string | null;
  freight_booking_ref: string | null;
  bl_awb_number: string | null;
  delivery_id: string | null;
  export_invoice_id: string | null;
  status: string;
  created_at: string;
  shipped_at: string | null;
  closed_at: string | null;
};

export type ServiceOrder = {
  service_order_id: string;
  customer_id: string | null;
  customer_name: string | null;
  service_type: string;
  scope_description: string;
  rate_type: string | null;
  rate: number | null;
  estimated_amount: number | null;
  status: string;
  created_at: string;
  actual_hours: number | null;
  billable_amount: number | null;
  signed_off_by: string | null;
  completed_at: string | null;
  invoice_id: string | null;
};

export type PostSalesAction = {
  post_sales_id: string;
  action: "RETURN" | "CREDIT_MEMO" | "DEBIT_MEMO";
  referenced_order_id: string | null;
  customer_id: string | null;
  customer_name: string | null;
  product_id: string | null;
  product_name: string | null;
  quantity: number | null;
  amount: number | null;
  reason: string;
  status: string;
  created_at: string;
  inspected_at: string | null;
  inspected_by: string | null;
};

export type Consignment = {
  consignment_id: string;
  customer_id: string | null;
  customer_name: string | null;
  product_id: string | null;
  product_name: string | null;
  unit_price: number | null;
  quantity_sent: number;
  quantity_sold: number;
  quantity_returned: number;
  quantity_remaining: number;
  notes: string | null;
  status: string;
  created_at: string;
  closed_at: string | null;
};

export type Project = {
  project_id: string;
  customer_id: string | null;
  customer_name: string | null;
  product_id: string | null;
  product_name: string | null;
  quantity: number | null;
  project_type: string;
  scope_description: string;
  contract_value: number | null;
  retention_percent: number;
  retention_held: number;
  retention_released: boolean;
  status: string;
  created_at: string;
  closed_at: string | null;
};

export type ProjectMilestone = {
  milestone_id: string;
  project_id: string;
  milestone_name: string;
  sequence: number;
  percent_of_contract: number;
  amount: number | null;
  status: string;
  signed_off_by: string | null;
  signed_off_at: string | null;
  invoice_id: string | null;
  billed_amount: number | null;
};

export type TradingOrder = {
  trading_order_id: string;
  sales_order_id: string | null;
  product_id: string;
  product_name: string;
  vendor_id: string;
  vendor_name: string;
  quantity: number;
  unit_cost: number;
  total_cost: number;
  expected_arrival: string;
  status: string;
  created_at: string;
};
