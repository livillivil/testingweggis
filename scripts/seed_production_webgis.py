"""
Seed production-ready WebGIS state for KMC Municipal WebGIS.
Populates:
1. 5 Role-based Users (MasterAdmin, SuperAdmin, DepartmentAdmin, Validator, DataCollector, BasicViewer)
2. Municipal Department
3. Production Spatial Survey Project (Ward 23 & Core Area)
4. Vector Layers (Buildings with the 3 uploaded layers, Roads, Gates, and Questionnaire-linked Survey Layer)
5. Dynamic ODK-compatible Questionnaire linked to vector layer
6. AOI Grids assigned to Collector & Validator with locking & progress tracking
7. Metric House Numbering execution (Road-connected odd/even parity + Isolated Off-Road RNR numbers)
8. PostGIS and kmc_state_store.json synchronization
"""

import os
import sys
import time
import json
import asyncio
from sqlalchemy import text

# Import backend modules
sys.path.insert(0, "/app")
from app.main import (
    STATE,
    hash_password,
    _save_persistent_state,
    set_layer_features,
    get_layer_features_list,
    get_or_build_spatial_index,
    invalidate_spatial_index,
    get_uploads_dir,
    get_tileserver_dir,
    _load_persistent_state,
    _scan_and_sync_tileserver_mbtiles,
)
from app.db import get_engine

async def seed_all():
    print("=== Starting Production WebGIS Seed ===")
    _load_persistent_state()
    _scan_and_sync_tileserver_mbtiles()

    # 1. Departments
    dept_id = 1
    departments = [
        {
            "id": dept_id,
            "name": "Urban Development & Infrastructure Department",
            "name_ne": "शहरी विकास तथा पूर्वाधार विभाग",
            "code": "UDID",
            "head_name": "ई. रामेश्वर अधिकारी",
            "contact_email": "urban@kmc.gov.np",
            "created_at": time.time(),
        }
    ]
    STATE["departments"] = departments

    # 2. Users (5 hierarchical tiers)
    users = [
        {
            "id": 1,
            "username": "KmcSuperAdmin",
            "email": "admin@kmc.gov.np",
            "full_name": "GIS Super Admin (Super Admin)",
            "role": "SuperAdmin",
            "assigned_ward": 0,
            "department_id": dept_id,
            "department": "शहरी विकास तथा पूर्वाधार विभाग",
            "password_hash": hash_password("KmcSuperAdmin@2083"),
            "is_active": True,
            "created_at": time.time(),
        },
        {
            "id": 2,
            "username": "KmcMasterAdmin",
            "email": "master@kmc.gov.np",
            "full_name": "System Master Admin",
            "role": "MasterAdmin",
            "assigned_ward": 0,
            "department_id": dept_id,
            "department": "शहरी विकास तथा पूर्वाधार विभाग",
            "password_hash": hash_password("KmcMasterAdmin@2083"),
            "is_active": True,
            "created_at": time.time(),
        },
        {
            "id": 3,
            "username": "KmcDeptAdmin",
            "email": "dept_head@kmc.gov.np",
            "full_name": "ई. रामेश्वर अधिकारी (Urban Dept Head)",
            "role": "DepartmentAdmin",
            "assigned_ward": 23,
            "department_id": dept_id,
            "department": "शहरी विकास तथा पूर्वाधार विभाग",
            "assigned_projects": [101],
            "password_hash": hash_password("KmcDeptAdmin@2083"),
            "is_active": True,
            "created_at": time.time(),
        },
        {
            "id": 4,
            "username": "KmcValidator",
            "email": "validator@kmc.gov.np",
            "full_name": "ई. सुनिता शाक्य (GIS QA Validator)",
            "role": "Validator",
            "assigned_ward": 23,
            "department_id": dept_id,
            "department": "शहरी विकास तथा पूर्वाधार विभाग",
            "assigned_projects": [101],
            "password_hash": hash_password("KmcValidator@2083"),
            "is_active": True,
            "created_at": time.time(),
        },
        {
            "id": 5,
            "username": "KmcCollector",
            "email": "collector@kmc.gov.np",
            "full_name": "अमित कुमार श्रेष्ठ (Field Surveyor)",
            "role": "DataCollector",
            "assigned_ward": 23,
            "department_id": dept_id,
            "department": "शहरी विकास तथा पूर्वाधार विभाग",
            "assigned_projects": [101],
            "password_hash": hash_password("KmcCollector@2083"),
            "is_active": True,
            "created_at": time.time(),
        },
        {
            "id": 6,
            "username": "KmcViewer",
            "email": "viewer@kmc.gov.np",
            "full_name": "सार्वजनिक नागरिक (Public Citizen Viewer)",
            "role": "BasicViewer",
            "assigned_ward": 0,
            "department_id": None,
            "department": "",
            "password_hash": hash_password("KmcViewer@2083"),
            "is_active": True,
            "created_at": time.time(),
        },
    ]
    STATE["users"] = users
    print(f"-> Seeded {len(users)} role-governed users.")

    # 3. Project Definition
    project_id = 101
    building_layer_id = 10101
    road_layer_id = 10102
    gate_layer_id = 10103
    survey_layer_id = 10104

    project = {
        "id": project_id,
        "name": "Kathmandu Municipal Spatial Survey Project",
        "name_ne": "काठमाडौँ महानगरपालिका एकीकृत भू-सर्वेक्षण तथा नक्साङ्कन आयोजना",
        "description": "Integrated municipal spatial survey, building footprint inventory, road network mapping, dynamic field collection, and metric house numbering",
        "status": "active",
        "project_mode": "STANDARD",
        "department_id": dept_id,
        "department_admin_ids": [3],
        "validator_ids": [4],
        "collector_ids": [5],
        "assigned_wards": [1, 2, 3, 23, 24],
        "active_ward": 23,
        "editable_layer_ids": [building_layer_id, road_layer_id, gate_layer_id, survey_layer_id],
        "house_numbering_enabled": True,
        "house_numbering_config": {
            "house_numbering_enabled": True,
            "building_layer_id": building_layer_id,
            "road_layer_id": road_layer_id,
            "gate_layer_id": gate_layer_id,
            "prefix": "KMC-",
            "numbering_scheme": "METRIC",
            "interval": 2,
            "max_distance": 100.0,
            "start_number": 10,
        },
        "created_by": 1,
        "created_at": time.time(),
        "updated_at": time.time(),
    }
    STATE["projects"] = [project]
    STATE.setdefault("project_collectors", {})[project_id] = [3, 4, 5]
    STATE.setdefault("project_collectors", {})[str(project_id)] = [3, 4, 5]
    print(f"-> Seeded Project {project_id}: '{project['name']}' with House Numbering enabled.")

    # 4. Building Features (The 3 uploaded layers integrated into building layer)
    # Feature 1: KMC Headquarters (from kmc_hq.geojson, government)
    # Feature 2: Building 1 (from test_buildings.geojson, commercial)
    # Feature 3: Patan Durbar Building (from heritage_buildings.geojson, heritage)
    bldg_features = [
        {
            "type": "Feature",
            "id": 1,
            "properties": {
                "_id": 1,
                "name": "KMC Headquarters Building",
                "building_code": "KMC-BLD-001",
                "building_type": "government",
                "building_use": "Government / Municipal HQ",
                "number_of_floors": 6,
                "ward_no": 23,
                "owner_name": "काठमाडौँ महानगरपालिका",
                "_created_by": 1,
                "_created_by_username": "KmcSuperAdmin",
                "_status": "APPROVED",
            },
            "geometry": {
                "type": "Polygon",
                "coordinates": [
                    [
                        [85.3161945, 27.7171051],
                        [85.3167015, 27.7171113],
                        [85.3166946, 27.7175625],
                        [85.3161876, 27.7175563],
                        [85.3161945, 27.7171051],
                    ]
                ],
            },
        },
        {
            "type": "Feature",
            "id": 2,
            "properties": {
                "_id": 2,
                "name": "Building 1 (Commercial Complex)",
                "building_code": "KMC-BLD-002",
                "building_type": "commercial",
                "building_use": "Commercial & Retail",
                "number_of_floors": 4,
                "ward_no": 23,
                "owner_name": "हिमालयन इन्भेस्टमेन्ट प्रा.लि.",
                "_created_by": 5,
                "_created_by_username": "KmcCollector",
                "_status": "APPROVED",
            },
            "geometry": {
                "type": "Polygon",
                "coordinates": [
                    [
                        [85.324, 27.717],
                        [85.325, 27.717],
                        [85.325, 27.718],
                        [85.324, 27.718],
                        [85.324, 27.717],
                    ]
                ],
            },
        },
        {
            "type": "Feature",
            "id": 101,
            "properties": {
                "_id": 101,
                "name": "Patan Durbar Area Heritage Building",
                "building_code": "KMC-BLD-101",
                "building_type": "heritage",
                "building_use": "Historical & Heritage Monument",
                "number_of_floors": 3,
                "ward_no": 23,
                "owner_name": "पुरातत्व विभाग",
                "_created_by": 1,
                "_created_by_username": "KmcSuperAdmin",
                "_status": "APPROVED",
            },
            "geometry": {
                "type": "Polygon",
                "coordinates": [
                    [
                        [85.325, 27.673],
                        [85.326, 27.673],
                        [85.326, 27.674],
                        [85.325, 27.674],
                        [85.325, 27.673],
                    ]
                ],
            },
        },
    ]

    # Road Features
    road_features = [
        {
            "type": "Feature",
            "id": 1,
            "properties": {
                "_id": 1,
                "name": "Kanti Path (कान्तिपथ)",
                "road_name": "Kanti Path",
                "road_class": "primary",
                "road_width": 14.0,
                "surface_type": "Asphalt",
                "ward_no": 23,
            },
            "geometry": {
                "type": "LineString",
                "coordinates": [
                    [85.3150, 27.7169],
                    [85.3165, 27.7169],
                    [85.3180, 27.7169],
                ],
            },
        },
        {
            "type": "Feature",
            "id": 2,
            "properties": {
                "_id": 2,
                "name": "Durbar Marg (दरबार मार्ग)",
                "road_name": "Durbar Marg",
                "road_class": "primary",
                "road_width": 16.0,
                "surface_type": "Asphalt",
                "ward_no": 23,
            },
            "geometry": {
                "type": "LineString",
                "coordinates": [
                    [85.3230, 27.7168],
                    [85.3250, 27.7168],
                    [85.3270, 27.7168],
                ],
            },
        },
    ]

    # Gate Features
    gate_features = [
        {
            "type": "Feature",
            "id": 1,
            "properties": {
                "_id": 1,
                "name": "KMC HQ Main Gate",
                "gate_type": "Main Entrance",
                "building_id": 1,
                "road_name": "Kanti Path",
            },
            "geometry": {
                "type": "Point",
                "coordinates": [85.3164, 27.7170],
            },
        },
        {
            "type": "Feature",
            "id": 2,
            "properties": {
                "_id": 2,
                "name": "Commercial Complex Entrance",
                "gate_type": "Pedestrian & Vehicle",
                "building_id": 2,
                "road_name": "Durbar Marg",
            },
            "geometry": {
                "type": "Point",
                "coordinates": [85.3245, 27.7170],
            },
        },
    ]

    # 5. Layers Definition
    layers = [
        {
            "id": building_layer_id,
            "name": "KMC Municipal Buildings (भवन संरचना तह)",
            "filename": "kmc_buildings.geojson",
            "description": "KMC building footprints combining municipal HQ, commercial, and heritage structures",
            "type": "vector",
            "geometry_type": "Polygon",
            "creation_geometry_types": ["Polygon"],
            "category": "भवन तथा संरचना (Buildings)",
            "is_global": False,
            "project_id": project_id,
            "project_name": project["name"],
            "house_numbering_role": "building",
            "is_house_number_layer": True,
            "allow_snapping": True,
            "editable_by_collectors": True,
            "published": True,
            "default_visible": True,
            "access_level": "public",
            "opacity": 1,
            "feature_count": len(bldg_features),
            "bounds": [85.3161, 27.6730, 85.3260, 27.7180],
            "bbox": [85.3161, 27.6730, 85.3260, 27.7180],
            "style": {"strokeColor": "#0284c7", "fillColor": "#38bdf8", "strokeWidth": 2.5, "fillOpacity": 0.35, "clickTolerance": 14},
            "fields_config": [
                {"name": "name", "label": "Building Name", "type": "text", "required": False, "visible_in_popup": True},
                {"name": "building_code", "label": "Building Code", "type": "text", "required": True, "visible_in_popup": True},
                {"name": "house_number", "label": "House Number (घर नं.)", "type": "text", "required": False, "visible_in_popup": True},
                {"name": "building_type", "label": "Building Type", "type": "select", "required": True, "visible_in_popup": True},
                {"name": "building_use", "label": "Building Use", "type": "text", "required": False, "visible_in_popup": True},
                {"name": "number_of_floors", "label": "Floors", "type": "number", "required": False, "visible_in_popup": True},
                {"name": "owner_name", "label": "Owner Name", "type": "text", "required": False, "visible_in_popup": True},
            ],
            "created_at": time.time(),
        },
        {
            "id": road_layer_id,
            "name": "KMC Road Network (सडक सञ्जाल)",
            "filename": "kmc_roads.geojson",
            "description": "Municipal arterial and local road centerlines with metric chainage references",
            "type": "vector",
            "geometry_type": "LineString",
            "creation_geometry_types": ["LineString"],
            "category": "सडक तथा यातायात (Roads)",
            "is_global": False,
            "project_id": project_id,
            "project_name": project["name"],
            "house_numbering_role": "road",
            "allow_snapping": True,
            "editable_by_collectors": True,
            "published": True,
            "default_visible": True,
            "access_level": "public",
            "opacity": 1,
            "feature_count": len(road_features),
            "bounds": [85.3150, 27.7168, 85.3270, 27.7169],
            "bbox": [85.3150, 27.7168, 85.3270, 27.7169],
            "style": {"strokeColor": "#f59e0b", "strokeWidth": 3.5, "clickTolerance": 14},
            "fields_config": [
                {"name": "name", "label": "Road Name", "type": "text", "required": True, "visible_in_popup": True},
                {"name": "road_class", "label": "Road Class", "type": "select", "required": True, "visible_in_popup": True},
                {"name": "road_width", "label": "Width (m)", "type": "number", "required": False, "visible_in_popup": True},
                {"name": "surface_type", "label": "Surface", "type": "text", "required": False, "visible_in_popup": True},
            ],
            "created_at": time.time(),
        },
        {
            "id": gate_layer_id,
            "name": "KMC Building Gates & Entrances (प्रवेशद्वार तह)",
            "filename": "kmc_gates.geojson",
            "description": "Surveyed building entrances and parcel access gates",
            "type": "vector",
            "geometry_type": "Point",
            "creation_geometry_types": ["Point"],
            "category": "प्रवेशद्वार तथा पहुँच (Gates)",
            "is_global": False,
            "project_id": project_id,
            "project_name": project["name"],
            "house_numbering_role": "gate",
            "allow_snapping": True,
            "editable_by_collectors": True,
            "published": True,
            "default_visible": True,
            "access_level": "public",
            "opacity": 1,
            "feature_count": len(gate_features),
            "bounds": [85.3164, 27.7170, 85.3245, 27.7170],
            "bbox": [85.3164, 27.7170, 85.3245, 27.7170],
            "style": {"strokeColor": "#dc2626", "fillColor": "#ef4444", "radius": 6, "clickTolerance": 14},
            "fields_config": [
                {"name": "name", "label": "Gate Name", "type": "text", "required": True, "visible_in_popup": True},
                {"name": "gate_type", "label": "Gate Type", "type": "select", "required": False, "visible_in_popup": True},
                {"name": "road_name", "label": "Connected Road", "type": "text", "required": False, "visible_in_popup": True},
            ],
            "created_at": time.time(),
        },
        {
            "id": survey_layer_id,
            "name": "KMC Field Survey Layer (क्षेत्रीय सर्वेक्षण तह)",
            "filename": "kmc_surveys.geojson",
            "description": "Dynamic questionnaire schema-linked survey collection layer",
            "type": "vector",
            "geometry_type": "Point",
            "creation_geometry_types": ["Point", "Polygon"],
            "category": "क्षेत्रीय सर्वेक्षण (Field Surveys)",
            "is_global": False,
            "project_id": project_id,
            "project_name": project["name"],
            "questionnaire_id": 201,
            "allow_snapping": True,
            "editable_by_collectors": True,
            "published": True,
            "default_visible": True,
            "access_level": "public",
            "opacity": 1,
            "feature_count": 0,
            "bounds": [85.310, 27.670, 85.335, 27.725],
            "bbox": [85.310, 27.670, 85.335, 27.725],
            "style": {"strokeColor": "#10b981", "fillColor": "#34d399", "radius": 7, "clickTolerance": 14},
            "fields_config": [
                {"name": "collector_name", "label": "Collector Name", "type": "text", "required": True, "visible_in_popup": True},
                {"name": "ward_no", "label": "Ward Number", "type": "number", "required": True, "visible_in_popup": True},
                {"name": "survey_date", "label": "Survey Date", "type": "text", "required": True, "visible_in_popup": True},
                {"name": "building_code", "label": "Building Code", "type": "text", "required": True, "visible_in_popup": True},
                {"name": "building_use", "label": "Building Use", "type": "select", "required": True, "visible_in_popup": True},
                {"name": "number_of_floors", "label": "Floors", "type": "number", "required": True, "visible_in_popup": True},
                {"name": "structure_type", "label": "Structure Type", "type": "select", "required": False, "visible_in_popup": True},
                {"name": "has_house_number", "label": "Has House Number?", "type": "select", "required": False, "visible_in_popup": True},
                {"name": "house_number", "label": "House Number", "type": "text", "required": False, "visible_in_popup": True},
                {"name": "remarks", "label": "Remarks", "type": "text", "required": False, "visible_in_popup": True},
            ],
            "created_at": time.time(),
        },
    ]

    # Preserve existing uploaded vector layers
    existing_uploaded = [l for l in STATE.get("vector_layers", []) if l.get("id") not in [building_layer_id, road_layer_id, gate_layer_id, survey_layer_id]]
    STATE["vector_layers"] = layers + existing_uploaded
    set_layer_features(building_layer_id, bldg_features)
    set_layer_features(road_layer_id, road_features)
    set_layer_features(gate_layer_id, gate_features)
    set_layer_features(survey_layer_id, [])

    # Also persist to dedicated layer files
    layers_dir = os.path.join(get_uploads_dir(), "layers")
    os.makedirs(layers_dir, exist_ok=True)
    with open(os.path.join(layers_dir, f"{building_layer_id}_features.json"), "w", encoding="utf-8") as f:
        json.dump(bldg_features, f)
    with open(os.path.join(layers_dir, f"{road_layer_id}_features.json"), "w", encoding="utf-8") as f:
        json.dump(road_features, f)
    with open(os.path.join(layers_dir, f"{gate_layer_id}_features.json"), "w", encoding="utf-8") as f:
        json.dump(gate_features, f)
    print(f"-> Seeded {len(layers)} vector layers with full geometry topologies.")

    # 6. Dynamic Questionnaire
    q_id = 201
    questionnaire = {
        "id": q_id,
        "project_id": project_id,
        "is_global": False,
        "title": "काठमाडौँ महानगरपालिका एकीकृत भवन तथा भौतिक पूर्वाधार सर्वेक्षण फारम",
        "title_ne": "काठमाडौँ महानगरपालिका एकीकृत भवन तथा भौतिक पूर्वाधार सर्वेक्षण फारम",
        "description": "Comprehensive municipal field survey form for building audit, infrastructure mapping, and house numbering validation.",
        "status": "published",
        "version": 1,
        "linked_layer_id": survey_layer_id,
        "sections": [
            {
                "id": "sec_general",
                "title": "सामान्य जानकारी (General Information)",
                "title_ne": "सामान्य जानकारी",
                "questions": [
                    {
                        "id": "q_collector_name",
                        "name": "collector_name",
                        "title": "सर्वेक्षकको नाम (Collector Name)",
                        "type": "text",
                        "required": True,
                    },
                    {
                        "id": "q_ward_no",
                        "name": "ward_no",
                        "title": "वडा नम्बर (Ward Number)",
                        "type": "select",
                        "required": True,
                        "options": [
                            {"value": "1", "label": "Ward 1"},
                            {"value": "2", "label": "Ward 2"},
                            {"value": "3", "label": "Ward 3"},
                            {"value": "23", "label": "Ward 23"},
                            {"value": "24", "label": "Ward 24"},
                        ],
                    },
                    {
                        "id": "q_survey_date",
                        "name": "survey_date",
                        "title": "सर्वेक्षण मिति (Survey Date)",
                        "type": "date",
                        "required": True,
                    },
                ],
            },
            {
                "id": "sec_building",
                "title": "भवन तथा संरचना विवरण (Building Details)",
                "title_ne": "भवन तथा संरचना विवरण",
                "questions": [
                    {
                        "id": "q_building_code",
                        "name": "building_code",
                        "title": "भवन कोड (Building Code - e.g. KMC-1024)",
                        "type": "text",
                        "required": True,
                        "validation_regex": "^KMC-[0-9]{3,6}$",
                        "validation_message": "Format must be KMC-XXXX (e.g. KMC-1024)",
                    },
                    {
                        "id": "q_building_use",
                        "name": "building_use",
                        "title": "भवनको उपयोग (Building Use)",
                        "type": "select",
                        "required": True,
                        "options": [
                            {"value": "Residential", "label": "आवासीय (Residential)"},
                            {"value": "Commercial", "label": "व्यापारिक (Commercial)"},
                            {"value": "Government", "label": "सरकारी (Government)"},
                            {"value": "Heritage", "label": "सम्पदा / पुरातात्विक (Heritage)"},
                            {"value": "Mixed", "label": "मिश्रित (Mixed)"},
                        ],
                    },
                    {
                        "id": "q_floors",
                        "name": "number_of_floors",
                        "title": "तला संख्या (Number of Floors)",
                        "type": "number",
                        "required": True,
                        "min_value": 1,
                        "max_value": 50,
                    },
                    {
                        "id": "q_structure",
                        "name": "structure_type",
                        "title": "संरचनाको प्रकार (Structure Type)",
                        "type": "select",
                        "required": False,
                        "options": [
                            {"value": "RCC Frame", "label": "पक्की पिलर फ्रेम (RCC Frame)"},
                            {"value": "Load Bearing", "label": "लोड बेयरिङ पर्खाल (Load Bearing Masonry)"},
                            {"value": "Traditional", "label": "परम्परागत माटो/काठ (Traditional/Heritage)"},
                            {"value": "Steel", "label": "स्टिल ट्रस (Steel Truss)"},
                        ],
                    },
                ],
            },
            {
                "id": "sec_house_num",
                "title": "घर नम्बरिङ तथा पहुँच (House Numbering & Access)",
                "title_ne": "घर नम्बरिङ तथा पहुँच",
                "questions": [
                    {
                        "id": "q_has_hn",
                        "name": "has_house_number",
                        "title": "घर नम्बर जडान भएको छ? (Has House Number?)",
                        "type": "select",
                        "required": False,
                        "options": [
                            {"value": "Yes", "label": "छ (Yes)"},
                            {"value": "No", "label": "छैन (No)"},
                        ],
                    },
                    {
                        "id": "q_house_num",
                        "name": "house_number",
                        "title": "घर नम्बर (House Number)",
                        "type": "text",
                        "required": False,
                        "condition": {"question_id": "q_has_hn", "operator": "equals", "value": "Yes"},
                    },
                    {
                        "id": "q_road_width",
                        "name": "road_access_width_m",
                        "title": "पहुँच सडक चौडाइ (Road Width in Metres)",
                        "type": "number",
                        "required": False,
                        "min_value": 0.5,
                        "max_value": 50.0,
                    },
                ],
            },
            {
                "id": "sec_remarks",
                "title": "कैफियत तथा फोटो (Remarks & Evidence)",
                "title_ne": "कैफियत तथा फोटो",
                "questions": [
                    {
                        "id": "q_remarks",
                        "name": "remarks",
                        "title": "कैफियत (Surveyor Remarks)",
                        "type": "text",
                        "required": False,
                    },
                ],
            },
        ],
        "created_at": time.time(),
        "updated_at": time.time(),
    }
    STATE["questionnaires"] = [questionnaire]
    print(f"-> Seeded Dynamic Questionnaire {q_id}: '{questionnaire['title']}' linked to layer {survey_layer_id}.")

    # 7. AOI Grids Management (3 Grid Tasks with full status governance)
    tasks = [
        {
            "id": 1,
            "project_id": project_id,
            "name": "कार्यक्षेत्र ग्रिड #1 (KMC HQ & Kanti Path Sector)",
            "status": "IN_PROGRESS",
            "assigned_to": 5,
            "assigned_username": "KmcCollector",
            "assigned_full_name": "अमित कुमार श्रेष्ठ (Field Surveyor)",
            "validator_id": 4,
            "validator_username": "KmcValidator",
            "validator_full_name": "ई. सुनिता शाक्य (GIS QA Validator)",
            "feature_count": 1,
            "progress_percent": 65,
            "is_locked": False,
            "geometry": {
                "type": "Polygon",
                "coordinates": [
                    [
                        [85.3140, 27.7155],
                        [85.3190, 27.7155],
                        [85.3190, 27.7190],
                        [85.3140, 27.7190],
                        [85.3140, 27.7155],
                    ]
                ],
            },
            "created_at": time.time(),
        },
        {
            "id": 2,
            "project_id": project_id,
            "name": "कार्यक्षेत्र ग्रिड #2 (Durbar Marg Commercial Sector)",
            "status": "READY",
            "assigned_to": 5,
            "assigned_username": "KmcCollector",
            "assigned_full_name": "अमित कुमार श्रेष्ठ (Field Surveyor)",
            "validator_id": 4,
            "validator_username": "KmcValidator",
            "validator_full_name": "ई. सुनिता शाक्य (GIS QA Validator)",
            "feature_count": 1,
            "progress_percent": 20,
            "is_locked": False,
            "geometry": {
                "type": "Polygon",
                "coordinates": [
                    [
                        [85.3220, 27.7155],
                        [85.3270, 27.7155],
                        [85.3270, 27.7190],
                        [85.3220, 27.7190],
                        [85.3220, 27.7155],
                    ]
                ],
            },
            "created_at": time.time(),
        },
        {
            "id": 3,
            "project_id": project_id,
            "name": "कार्यक्षेत्र ग्रिड #3 (Patan Durbar Heritage Sector)",
            "status": "VALIDATED",
            "assigned_to": 5,
            "assigned_username": "KmcCollector",
            "assigned_full_name": "अमित कुमार श्रेष्ठ (Field Surveyor)",
            "validator_id": 4,
            "validator_username": "KmcValidator",
            "validator_full_name": "ई. सुनिता शाक्य (GIS QA Validator)",
            "feature_count": 1,
            "progress_percent": 100,
            "is_locked": True,
            "locked_by": 4,
            "locked_at": time.time() - 3600,
            "geometry": {
                "type": "Polygon",
                "coordinates": [
                    [
                        [85.3230, 27.6710],
                        [85.3280, 27.6710],
                        [85.3280, 27.6755],
                        [85.3230, 27.6755],
                        [85.3230, 27.6710],
                    ]
                ],
            },
            "created_at": time.time(),
        },
    ]
    STATE.setdefault("tasks_by_project", {})[project_id] = tasks
    STATE.setdefault("project_assignments", {})[project_id] = {
        "5": [1, 2, 3],
        "4": [1, 2, 3],
    }
    print(f"-> Seeded {len(tasks)} AOI Grids with role workflow (IN_PROGRESS, READY, VALIDATED/LOCKED).")

    # 8. Metric House Numbering Generation
    # Building 1 (KMC HQ): Road-connected to Kanti Path -> chainage ~44m -> Even right -> KMC-44R
    # Building 2 (Commercial Complex): Road-connected to Durbar Marg -> chainage ~66m -> Odd left -> KMC-67L
    # Building 101 (Patan Durbar): Off-road / isolated (>4km away from road) -> RNR-1 -> KMC-RNR-1
    house_numbers = [
        {
            "id": 1,
            "building_id": 1,
            "house_number": "KMC-44R",
            "metric_house_no": "KMC-44R",
            "building_code": "KMC-BLD-001",
            "owner_name": "काठमाडौँ महानगरपालिका",
            "road_name": "Kanti Path",
            "ward": "23",
            "ward_no": 23,
            "side": "RIGHT",
            "chainage_m": 44.0,
            "metric_distance": 44.0,
            "distance_m": 22.5,
            "latitude": 27.7173,
            "longitude": 85.3164,
            "status": "ASSIGNED",
            "qr_verified": True,
            "geometry": {"type": "Point", "coordinates": [85.3164, 27.7173]},
        },
        {
            "id": 2,
            "building_id": 2,
            "house_number": "KMC-67L",
            "metric_house_no": "KMC-67L",
            "building_code": "KMC-BLD-002",
            "owner_name": "हिमालयन इन्भेस्टमेन्ट प्रा.लि.",
            "road_name": "Durbar Marg",
            "ward": "23",
            "ward_no": 23,
            "side": "LEFT",
            "chainage_m": 66.0,
            "metric_distance": 66.0,
            "distance_m": 35.0,
            "latitude": 27.7175,
            "longitude": 85.3245,
            "status": "ASSIGNED",
            "qr_verified": False,
            "geometry": {"type": "Point", "coordinates": [85.3245, 27.7175]},
        },
        {
            "id": 3,
            "building_id": 101,
            "house_number": "KMC-RNR-1",
            "metric_house_no": "KMC-RNR-1",
            "building_code": "KMC-BLD-101",
            "owner_name": "पुरातत्व विभाग",
            "road_name": "Non-Road / RNR",
            "ward": "23",
            "ward_no": 23,
            "side": "ISOLATED",
            "chainage_m": 0.0,
            "metric_distance": 0.0,
            "distance_m": 4120.0,
            "latitude": 27.6735,
            "longitude": 85.3255,
            "status": "ASSIGNED",
            "qr_verified": True,
            "geometry": {"type": "Point", "coordinates": [85.3255, 27.6735]},
        },
    ]
    STATE["house_numbers"] = house_numbers

    # Stamp house numbers back into building features
    bldg_features[0]["properties"]["house_number"] = "KMC-44R"
    bldg_features[0]["properties"]["metric_house_no"] = "KMC-44R"
    bldg_features[1]["properties"]["house_number"] = "KMC-67L"
    bldg_features[1]["properties"]["metric_house_no"] = "KMC-67L"
    bldg_features[2]["properties"]["house_number"] = "KMC-RNR-1"
    bldg_features[2]["properties"]["metric_house_no"] = "KMC-RNR-1"

    set_layer_features(building_layer_id, bldg_features)
    with open(os.path.join(layers_dir, f"{building_layer_id}_features.json"), "w", encoding="utf-8") as f:
        json.dump(bldg_features, f)
    print(f"-> Seeded {len(house_numbers)} House Numbers (Road-Connected Metric + Isolated RNR numbers).")

    # 9. Sync into PostGIS Database
    print("-> Synchronizing into PostGIS Geodatabase...")
    try:
        engine = get_engine()
        async with engine.begin() as conn:
            # Upsert departments
            await conn.execute(
                text("""
                    INSERT INTO departments (id, name, name_ne, code)
                    VALUES (:id, :name, :name_ne, :code)
                    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, name_ne = EXCLUDED.name_ne, code = EXCLUDED.code;
                """),
                {"id": dept_id, "name": departments[0]["name"], "name_ne": departments[0]["name_ne"], "code": departments[0]["code"]}
            )

            # Upsert users
            for u in users:
                await conn.execute(
                    text("""
                        INSERT INTO users (id, username, email, hashed_password, full_name, role, department_id, assigned_ward, is_active)
                        VALUES (:id, :username, :email, :hashed_password, :full_name, CAST(:role AS userrole), :department_id, :assigned_ward, :is_active)
                        ON CONFLICT (id) DO UPDATE SET
                            username = EXCLUDED.username,
                            email = EXCLUDED.email,
                            hashed_password = EXCLUDED.hashed_password,
                            full_name = EXCLUDED.full_name,
                            role = EXCLUDED.role,
                            department_id = EXCLUDED.department_id,
                            assigned_ward = EXCLUDED.assigned_ward,
                            is_active = EXCLUDED.is_active;
                    """),
                    {
                        "id": u["id"],
                        "username": u["username"],
                        "email": u["email"],
                        "hashed_password": u["password_hash"],
                        "full_name": u["full_name"],
                        "role": u["role"],
                        "department_id": u["department_id"],
                        "assigned_ward": u["assigned_ward"],
                        "is_active": u["is_active"],
                    }
                )

            # Upsert survey_projects
            await conn.execute(
                text("""
                    INSERT INTO survey_projects (id, department_id, name, name_ne, status, mode, created_by, created_at)
                    VALUES (:id, :dept_id, :name, :name_ne, 'ACTIVE', 'STANDARD', 1, NOW())
                    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, name_ne = EXCLUDED.name_ne, department_id = EXCLUDED.department_id;
                """),
                {"id": project_id, "dept_id": dept_id, "name": project["name"], "name_ne": project["name_ne"]}
            )

            # Upsert task_grids
            grid_status_map = {
                "IN_PROGRESS": "LOCKED_FOR_MAPPING",
                "READY": "READY",
                "VALIDATED": "VALIDATED",
            }
            for idx, task in enumerate(tasks, 1):
                t_geom_json = json.dumps(task["geometry"])
                pg_status = grid_status_map.get(task["status"], "READY")
                await conn.execute(
                    text("""
                        INSERT INTO task_grids (id, project_id, grid_index, name, grid_shape, status, assigned_to, locked_by, geom, properties)
                        VALUES (:id, :project_id, :grid_index, :name, 'POLYGON', CAST(:status AS taskstatus), :assigned_to, :locked_by, ST_SetSRID(ST_GeomFromGeoJSON(:geom_json), 4326), CAST(:props AS jsonb))
                        ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, geom = EXCLUDED.geom, properties = EXCLUDED.properties;
                    """),
                    {
                        "id": task["id"],
                        "project_id": project_id,
                        "grid_index": idx,
                        "name": task["name"],
                        "status": pg_status,
                        "assigned_to": task["assigned_to"],
                        "locked_by": task.get("locked_by"),
                        "geom_json": t_geom_json,
                        "props": json.dumps({"feature_count": task.get("feature_count", 0), "progress_percent": task.get("progress_percent", 0)}),
                    }
                )

            # Upsert vector_layers
            for l in layers:
                await conn.execute(
                    text("""
                        INSERT INTO vector_layers (id, project_id, name, slug, geometry_type, allow_snapping, editable_by_collectors, published_in_geoportal, default_visible_in_geoportal, fields_config)
                        VALUES (:id, :project_id, :name, :slug, :geometry_type, :allow_snapping, :editable_by_collectors, true, true, CAST(:fields_json AS jsonb))
                        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, geometry_type = EXCLUDED.geometry_type, fields_config = EXCLUDED.fields_config;
                    """),
                    {
                        "id": l["id"],
                        "project_id": l["project_id"],
                        "name": l["name"],
                        "slug": f"layer_{l['id']}",
                        "geometry_type": l["geometry_type"],
                        "allow_snapping": l["allow_snapping"],
                        "editable_by_collectors": l["editable_by_collectors"],
                        "fields_json": json.dumps(l.get("fields_config", [])),
                    }
                )

            # Insert building features into vector_features
            await conn.execute(text("DELETE FROM vector_features WHERE layer_id = :lid;"), {"lid": building_layer_id})
            for b in bldg_features:
                await conn.execute(
                    text("""
                        INSERT INTO vector_features (record_id, layer_id, geom, properties, version, valid_from, created_by)
                        VALUES (:rec_id, :lid, ST_SetSRID(ST_GeomFromGeoJSON(:geom_json), 4326), CAST(:props AS jsonb), 1, NOW(), 1)
                        ON CONFLICT (record_id) DO UPDATE SET geom = EXCLUDED.geom, properties = EXCLUDED.properties;
                    """),
                    {
                        "rec_id": f"BLD_{b['id']}",
                        "lid": building_layer_id,
                        "geom_json": json.dumps(b["geometry"]),
                        "props": json.dumps(b["properties"]),
                    }
                )

            # Insert road features into vector_features
            await conn.execute(text("DELETE FROM vector_features WHERE layer_id = :lid;"), {"lid": road_layer_id})
            for r in road_features:
                await conn.execute(
                    text("""
                        INSERT INTO vector_features (record_id, layer_id, geom, properties, version, valid_from, created_by)
                        VALUES (:rec_id, :lid, ST_SetSRID(ST_GeomFromGeoJSON(:geom_json), 4326), CAST(:props AS jsonb), 1, NOW(), 1)
                        ON CONFLICT (record_id) DO UPDATE SET geom = EXCLUDED.geom, properties = EXCLUDED.properties;
                    """),
                    {
                        "rec_id": f"ROAD_{r['id']}",
                        "lid": road_layer_id,
                        "geom_json": json.dumps(r["geometry"]),
                        "props": json.dumps(r["properties"]),
                    }
                )

            # Insert gate features into vector_features
            await conn.execute(text("DELETE FROM vector_features WHERE layer_id = :lid;"), {"lid": gate_layer_id})
            for g in gate_features:
                await conn.execute(
                    text("""
                        INSERT INTO vector_features (record_id, layer_id, geom, properties, version, valid_from, created_by)
                        VALUES (:rec_id, :lid, ST_SetSRID(ST_GeomFromGeoJSON(:geom_json), 4326), CAST(:props AS jsonb), 1, NOW(), 1)
                        ON CONFLICT (record_id) DO UPDATE SET geom = EXCLUDED.geom, properties = EXCLUDED.properties;
                    """),
                    {
                        "rec_id": f"GATE_{g['id']}",
                        "lid": gate_layer_id,
                        "geom_json": json.dumps(g["geometry"]),
                        "props": json.dumps(g["properties"]),
                    }
                )

        print("-> Successfully synchronized all data into PostGIS tables!")
    except Exception as pg_err:
        print(f"-> Notice during PostGIS sync (continuing in hybrid mode): {pg_err}")

    # 10. Save permanent host state
    _save_persistent_state(sync=True)
    print("=== Production WebGIS Seed Completed Successfully ===")

if __name__ == "__main__":
    asyncio.run(seed_all())
