"""拒绝重复键和非标准数值，避免同一JSON存在多种解释。"""
import json

def parse_json(raw):
    def pairs(items):
        result={}
        for key,value in items:
            if key in result: raise ValueError('JSON存在重复键')
            result[key]=value
        return result
    def constant(_): raise ValueError('JSON包含非标准数值')
    return json.loads(raw,object_pairs_hook=pairs,parse_constant=constant)
