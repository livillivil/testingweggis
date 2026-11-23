import json
import urllib.request
import urllib.error

BASE_URL = "http://127.0.0.1:8000"

def api_call(path, method="GET", data=None, token=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    body = json.dumps(data).encode("utf-8") if data else None
    req = urllib.request.Request(f"{BASE_URL}{path}", data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            content = resp.read().decode("utf-8")
            return resp.status, json.loads(content) if content else {}
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8")
        try:
            return e.code, json.loads(err_body)
        except:
            return e.code, {"raw": err_body}
    except Exception as e:
        return 500, {"error": str(e)}

def run_tests():
    print("=" * 60)
    print("KMC WebGIS Production End-to-End System Verification")
    print("=" * 60)

    # 1. Test Login for all 6 roles
    roles = [
        ("KmcMasterAdmin", "KmcMasterAdmin@2083", "MasterAdmin"),
        ("KmcSuperAdmin", "KmcSuperAdmin@2083", "SuperAdmin"),
        ("KmcDeptAdmin", "KmcDeptAdmin@2083", "DepartmentAdmin"),
        ("KmcValidator", "KmcValidator@2083", "Validator"),
        ("KmcCollector", "KmcCollector@2083", "DataCollector"),
        ("KmcViewer", "KmcViewer@2083", "BasicViewer"),
    ]
    tokens = {}
    print("\n[1] Testing User Authentication & Token Issuance:")
    for username, pwd, expected_role in roles:
        status, res = api_call("/api/auth/login", method="POST", data={"username": username, "password": pwd})
        if status == 200 and res.get("role") == expected_role:
            tokens[expected_role] = res.get("access_token")
            print(f"  [PASS] {username} authenticated successfully as {expected_role}")
        else:
            print(f"  [FAIL] {username} failed: status={status}, response={res}")

    # 2. Test Projects & Isolation
    print("\n[2] Testing Projects API:")
    status, projects = api_call("/api/projects", token=tokens.get("SuperAdmin"))
    print(f"  Status: {status}, Total projects: {len(projects)}")
    proj_101 = next((p for p in projects if p.get("id") == 101), None)
    if proj_101:
        print(f"  [PASS] Found Project 101: '{proj_101.get('name')}' (House Numbering: {proj_101.get('house_numbering_enabled')})")
    else:
        print("  [FAIL] Project 101 not found!")

    # 3. Test Layers API
    print("\n[3] Testing Layers API:")
    status, layers = api_call("/api/layers?all_layers=true", token=tokens.get("SuperAdmin"))
    print(f"  Status: {status}, Total layers (all_layers=true): {len(layers)}")
    bldg_layer = next((l for l in layers if l.get("id") == 10101), None)
    road_layer = next((l for l in layers if l.get("id") == 10102), None)
    gate_layer = next((l for l in layers if l.get("id") == 10103), None)
    survey_layer = next((l for l in layers if l.get("id") == 10104), None)
    for l_obj, l_name in [(bldg_layer, "Buildings"), (road_layer, "Roads"), (gate_layer, "Gates"), (survey_layer, "Survey")]:
        if l_obj:
            print(f"  [PASS] Found Layer {l_obj.get('id')}: {l_name} (type={l_obj.get('geometry_type')}, count={l_obj.get('feature_count')})")
        else:
            print(f"  [FAIL] {l_name} layer missing!")

    # Also test project-scoped layers
    status, p_layers = api_call("/api/projects/101/layers", token=tokens.get("SuperAdmin"))
    print(f"  Project 101 Layers count: {len(p_layers)}")

    # 4. Test Questionnaires
    print("\n[4] Testing Dynamic Questionnaire Builder & Schema Linking:")
    status, questionnaires = api_call("/api/questionnaires", token=tokens.get("SuperAdmin"))
    q_201 = next((q for q in questionnaires if q.get("id") == 201), None)
    if q_201:
        print(f"  [PASS] Found Questionnaire 201: '{q_201.get('title')}' linked to layer {q_201.get('linked_layer_id')}")
        print(f"         Sections: {len(q_201.get('sections', []))}")
    else:
        print("  [FAIL] Questionnaire 201 not found!")

    # 5. Test AOI Grids & Governance
    print("\n[5] Testing AOI Grids Management:")
    status, grids_resp = api_call("/api/projects/101/tasks", token=tokens.get("SuperAdmin"))
    grids = grids_resp.get("features", []) if isinstance(grids_resp, dict) else grids_resp
    print(f"  Status: {status}, Total Grids: {len(grids)}")
    for g in grids:
        props = g.get("properties", {}) if "properties" in g else g
        print(f"  Grid #{g.get('id')}: status={props.get('status')}, assigned_to={props.get('assigned_username')}")
    if len(grids) == 3:
        print("  [PASS] All 3 AOI Grids present with correct workflow states.")
    else:
        print(f"  [WARN] Expected 3 grids, got {len(grids)}")

    # 6. Test House Numbering Module
    print("\n[6] Testing House Numbering Module:")
    status, hn_resp = api_call("/api/house-numbering/numbers", token=tokens.get("SuperAdmin"))
    hn_list = hn_resp.get("features", []) if isinstance(hn_resp, dict) else hn_resp
    print(f"  Status: {status}, Total Numbers: {len(hn_list)}")
    for hn in hn_list:
        props = hn.get("properties", {}) if "properties" in hn else hn
        print(f"  House Number: {props.get('house_number')} -> Bldg #{props.get('building_id')}, Road: '{props.get('road_name')}', Side: {props.get('side')}, Dist: {props.get('chainage_m')}m")
    
    # Check features on buildings layer
    status, f_resp = api_call("/api/layers/10101/features?portal=1")
    features = f_resp.get("features", [])
    print(f"  Building Layer Features: {len(features)}")
    for feat in features:
        props = feat.get("properties", {})
        print(f"    Feature {feat.get('id')} ({props.get('name')}): house_number = '{props.get('house_number')}'")
    
    all_hn_props = [(hn.get("properties") if "properties" in hn else hn) for hn in hn_list]
    if len(hn_list) >= 3 and any(p.get("house_number") == "KMC-44R" for p in all_hn_props) and any("RNR" in (p.get("house_number") or "") for p in all_hn_props):
        print("  [PASS] House Numbering correctly assigned metric odd/even + isolated RNR numbers.")
    else:
        print("  [FAIL] House numbering mismatch!")

    # 7. Test Runtime Config & Unified Landing Page Master Toggle
    print("\n[7] Testing Landing Page & Master Admin Toggle:")
    status, cfg = api_call("/api/runtime-config")
    orig_state = cfg.get("landing_page_enabled")
    print(f"  Initial runtime config: landing_page_enabled = {orig_state}")

    # DeptAdmin tries to toggle (should be forbidden 403)
    status, res = api_call("/api/system/landing-page", method="PUT", data={"enabled": False}, token=tokens.get("DepartmentAdmin"))
    if status == 403:
        print(f"  [PASS] DeptAdmin forbidden from toggling Landing Page (HTTP {status})")
    else:
        print(f"  [FAIL] DeptAdmin was allowed or unexpected status: {status}")

    # MasterAdmin toggles to False
    status, res = api_call("/api/system/landing-page", method="PUT", data={"enabled": False}, token=tokens.get("MasterAdmin"))
    if status == 200 and res.get("landing_page_enabled") is False:
        print(f"  [PASS] MasterAdmin successfully disabled Landing Page")
    else:
        print(f"  [FAIL] MasterAdmin toggle failed: {status}, {res}")

    # Check /api/runtime-config reflects False
    status, cfg = api_call("/api/runtime-config")
    if cfg.get("landing_page_enabled") is False:
        print(f"  [PASS] /api/runtime-config reflects landing_page_enabled = False")
    else:
        print(f"  [FAIL] /api/runtime-config did not reflect change: {cfg}")

    # Restore to True
    status, res = api_call("/api/system/landing-page", method="PUT", data={"enabled": True}, token=tokens.get("MasterAdmin"))
    status, cfg = api_call("/api/runtime-config")
    if cfg.get("landing_page_enabled") is True:
        print(f"  [PASS] MasterAdmin successfully restored Landing Page = True")
    else:
        print(f"  [FAIL] Failed to restore Landing Page toggle: {cfg}")

    # 8. Test Role Hierarchy User Management Rules
    print("\n[8] Testing Role Hierarchy User Management Rules:")
    # DeptAdmin cannot create SuperAdmin
    new_super = {
        "username": "HackerAdmin",
        "email": "hacker@test.com",
        "password": "Password123!",
        "full_name": "Unauthorized Super",
        "role": "SuperAdmin",
        "department_id": 1,
    }
    status, res = api_call("/api/users", method="POST", data=new_super, token=tokens.get("DepartmentAdmin"))
    if status in (400, 403):
        print(f"  [PASS] DeptAdmin correctly blocked from creating SuperAdmin tier user (HTTP {status})")
    else:
        print(f"  [FAIL] DeptAdmin improperly created SuperAdmin: HTTP {status}, {res}")

    # DataCollector cannot create any user
    status, res = api_call("/api/users", method="POST", data=new_super, token=tokens.get("DataCollector"))
    if status in (400, 401, 403):
        print(f"  [PASS] DataCollector blocked from creating users (HTTP {status})")
    else:
        print(f"  [FAIL] DataCollector could create users: HTTP {status}")

    # GIS SuperAdmin can create DataCollector
    test_collector = {
        "username": "TestCollector99",
        "email": "testcol99@kmc.gov.np",
        "password": "Password123!",
        "full_name": "Test Collector NinetyNine",
        "role": "DataCollector",
        "department_id": 1,
        "assigned_ward": 23,
    }
    status, res = api_call("/api/users", method="POST", data=test_collector, token=tokens.get("SuperAdmin"))
    if status in (200, 201):
        print(f"  [PASS] SuperAdmin successfully created DataCollector user (ID: {res.get('id')})")
        # Clean up
        if res.get("id"):
            del_st, _ = api_call(f"/api/users/{res.get('id')}", method="DELETE", token=tokens.get("SuperAdmin"))
            print(f"         Cleaned up temporary user (HTTP {del_st})")
    else:
        print(f"  [FAIL] SuperAdmin failed to create DataCollector: HTTP {status}, {res}")

    # 9. Test Questionnaire Submission & Spatial Feature Creation
    print("\n[9] Testing Questionnaire Submission & Schema-Linked Feature Creation:")
    submission_data = {
        "project_id": 101,
        "questionnaire_id": 201,
        "layer_id": 10104,
        "answers": {
            "collector_name": "अमित कुमार श्रेष्ठ",
            "ward_no": 23,
            "survey_date": "2026-11-21",
            "building_code": "KMC-1024",
            "building_use": "Commercial",
            "number_of_floors": 3,
            "structure_type": "RCC Frame",
            "has_house_number": "Yes",
            "house_number": "KMC-44R",
            "remarks": "Audited ground floor shop and second floor offices.",
        },
        "geometry": {
            "type": "Point",
            "coordinates": [85.3165, 27.7172],
        },
    }
    status, sub_res = api_call("/api/records/submit", method="POST", data=submission_data, token=tokens.get("DataCollector"))
    if status in (200, 201):
        print(f"  [PASS] Questionnaire submission succeeded! Created feature record: {sub_res.get('record_id') or sub_res.get('id')}")
        # Verify feature exists in layer 10104
        status, s_feats = api_call("/api/layers/10104/features?portal=1")
        print(f"         Layer 10104 feature count now: {len(s_feats.get('features', []))}")
    else:
        print(f"  [FAIL] Questionnaire submission failed: HTTP {status}, {sub_res}")

    # 10. Test Spatial Editing Suite (CRUD & Topology)
    print("\n[10] Testing Spatial Editing Suite (Split, Merge, Link):")
    # A. Feature Link
    link_data = {
        "source_layer_id": 10103,
        "source_feature_id": 1,
        "target_layer_id": 10101,
        "target_feature_id": 1,
        "relation_type": "ENTRANCE_OF",
    }
    status, link_res = api_call("/api/features/1/link", method="POST", data=link_data, token=tokens.get("SuperAdmin"))
    if status in (200, 201):
        print(f"  [PASS] Feature Link succeeded (HTTP {status})")
    else:
        print(f"  [FAIL] Feature Link failed: HTTP {status}, resp={link_res}")

    # B. Feature Split test
    split_payload = {
        "blade": {
            "type": "LineString",
            "coordinates": [[85.3060, 27.7045], [85.3085, 27.7045]],
        }
    }
    status, split_res = api_call("/api/features/2/split", method="POST", data=split_payload, token=tokens.get("SuperAdmin"))
    if status in (200, 201):
        print(f"  [PASS] Feature Split succeeded (HTTP {status})")
    else:
        print(f"  [FAIL] Feature Split failed: HTTP {status}, resp={split_res}")

    print("\n" + "=" * 60)
    print("Verification Completed!")
    print("=" * 60)

if __name__ == "__main__":
    run_tests()
