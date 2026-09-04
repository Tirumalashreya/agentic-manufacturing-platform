# One-time generator for mock_erp.xlsx — mirrors real ERP master-data
# structure (separate Customer Master / Product Master / Inventory tables,
# same shape SAP calls KNA1/MARA/MARD). Run once: python gen_mock_erp.py
import random
import openpyxl

random.seed(42)  # same data every time this is regenerated — reproducible tests

wb = openpyxl.Workbook()

# ---------------- Customer Master ----------------
customers = wb.active
customers.title = "Customer Master"
customers.append(["customer_id", "customer_name", "active", "credit_limit"])

customer_names = [
    "ABC Corp", "XYZ Industries", "Old Client Ltd", "Global Tech Solutions",
    "Metro Retail Group", "Sunrise Manufacturing", "Blue Ocean Traders",
    "Nova Electronics", "Pioneer Logistics", "Everest Distributors",
    "Silverline Enterprises", "Redwood Systems", "Falcon Technologies",
    "Harbor Textiles", "Crescent Pharma", "Titan Industrial Supplies",
    "Bluebird Retailers", "Northgate Traders", "Vertex Manufacturing",
    "Coastal Electronics Group", "Ironclad Logistics", "Maple Leaf Distributors",
    "Zenith Enterprises", "Orion Systems", "Cascade Textiles",
    "Summit Pharma Group", "Anchor Industrial Co", "Lighthouse Retail",
    "Frontier Traders", "Quantum Manufacturing",
]
for i, name in enumerate(customer_names, start=1):
    active = not (i % 7 == 0)  # a real spread of inactive accounts, not just 2
    credit_limit = random.choice([50000, 100000, 150000, 200000, 300000, 400000, 500000, 750000, 1000000])
    customers.append([f"C{i:03d}", name, active, credit_limit])

# ---------------- Product Master ----------------
products = wb.create_sheet("Product Master")
products.append(["product_id", "product_name", "price", "configurable", "can_produce", "lead_time_days"])

product_catalog = [
    ("Laptop - Standard", 50000, True, True, 20),
    ("Laptop - Gaming", 95000, True, True, 25),
    ("Laptop - Ultrabook", 78000, True, True, 22),
    ("Desktop - Standard", 35000, False, True, 15),
    ("Desktop - Workstation", 120000, True, True, 30),
    ("Monitor 24in", 8000, False, True, 5),
    ("Monitor 27in", 15000, False, True, 8),
    ("Monitor 32in Curved", 28000, False, True, 10),
    ("Server Rack Unit", 250000, True, True, 45),
    ("Server - Blade", 400000, True, True, 50),
    ("Wireless Mouse", 800, False, True, 3),
    ("Mechanical Keyboard", 3500, False, True, 7),
    ("External SSD 1TB", 6500, False, False, 0),   # vendor-sourced, not produced in-house
    ("External HDD 2TB", 4200, False, False, 0),
    ("Docking Station", 4200, False, True, 10),
    ("Webcam HD", 2200, False, False, 0),
    ("Network Switch 24-port", 18000, False, True, 12),
    ("Router - Enterprise", 22000, True, True, 14),
    ("UPS 1500VA", 9500, False, True, 6),
    ("Printer - Laser", 16000, False, True, 18),
    ("Printer - Multifunction", 24000, True, True, 20),
    ("Tablet - Standard", 28000, True, True, 15),
    ("Projector - HD", 32000, False, True, 16),
    ("Headset - Wireless", 3200, False, True, 5),
    ("Cable Management Kit", 900, False, True, 2),
]
for i, (name, price, configurable, can_produce, lead) in enumerate(product_catalog, start=1):
    products.append([f"P{i:03d}", name, price, configurable, can_produce, lead])

# ---------------- Inventory ----------------
inventory = wb.create_sheet("Inventory")
inventory.append(["product_id", "plant", "stock_qty"])

plants = ["PLANT01", "PLANT02"]
for i in range(1, len(product_catalog) + 1):
    for plant in plants:
        # deliberately include real zero-stock rows, not just high numbers,
        # so shortage scenarios are actually testable
        stock = random.choice([0, 0, 5, 15, 25, 40, 60, 100, 150, 300, 500])
        inventory.append([f"P{i:03d}", plant, stock])

wb.save("mock_erp.xlsx")
print(f"Wrote mock_erp.xlsx — {len(customer_names)} customers, {len(product_catalog)} products, {len(product_catalog) * len(plants)} inventory rows")
